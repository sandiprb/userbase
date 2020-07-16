import connection from './connection'
import setup from './setup'
import uuidv4 from 'uuid/v4'
import db from './db'
import logger from './logger'
import { estimateSizeOfDdbItem } from './utils'
import statusCodes from './statusCodes'

const SECONDS_BEFORE_ROLLBACK_GAP_TRIGGERED = 1000 * 10 // 10s
const TRANSACTION_SIZE_BUNDLE_TRIGGER = 1024 * 50 // 50 KB

const FILE_ID_CACHE_LIFE = 60 * 1000 // 60s

const WS_MAX_REQUESTS_PER_SECOND = 25

// caps single file download and upload speed at 100 mb/s
const FILE_STORAGE_MAX_REQUESTS_PER_SECOND = 200
const FILE_STORAGE_TOKENS_REFILLED_PER_SECOND = 200

// Rate limiter. Enforces a max of <capacity> requests per second. Once a token is taken from
// the bucket, it is refilled at a rate of 1 per second.
//
// source: https://kendru.github.io/javascript/2018/12/28/rate-limiting-in-javascript-with-a-token-bucket/
class TokenBucket {
  constructor(capacity, tokensRefilledPerSecond = 1) {
    this.capacity = this.tokens = capacity
    this.lastFilled = Date.now()
    this.tokensRefilledPerSecond = tokensRefilledPerSecond
  }

  atCapacity() {
    this.refillRequestTokens()

    if (this.tokens > 0) {
      this.tokens -= 1
      return false
    }

    return true
  }

  refillRequestTokens() {
    const now = Date.now()
    const secondsSinceLastFill = Math.floor((now - this.lastFilled) / 1000)

    this.tokens = Math.min(this.capacity, this.tokens + (secondsSinceLastFill * this.tokensRefilledPerSecond))
    this.lastFilled = now
  }
}

class Connection {
  constructor(userId, socket, clientId, adminId, appId) {
    this.userId = userId
    this.socket = socket
    this.clientId = clientId
    this.id = uuidv4()
    this.adminId = adminId
    this.appId = appId
    this.databases = {}
    this.keyValidated = false

    this.rateLimiter = new TokenBucket(WS_MAX_REQUESTS_PER_SECOND)
    this.fileStorageRateLimiter = new TokenBucket(FILE_STORAGE_MAX_REQUESTS_PER_SECOND, FILE_STORAGE_TOKENS_REFILLED_PER_SECOND)
  }

  openDatabase(databaseId, dbNameHash, bundleSeqNo, reopenAtSeqNo, isOwner) {
    this.databases[databaseId] = {
      bundleSeqNo: bundleSeqNo > 0 ? bundleSeqNo : -1,
      lastSeqNo: reopenAtSeqNo || 0,
      transactionLogSize: 0,
      init: reopenAtSeqNo !== undefined, // ensures server sends the dbNameHash & key on first ever push, not reopen
      dbNameHash,
      isOwner,
    }
  }

  validateKey() {
    this.keyValidated = true
  }

  async push(databaseId, dbNameHash, dbKey, reopenAtSeqNo) {
    const database = this.databases[databaseId]
    if (!database) return

    const payload = {
      route: 'ApplyTransactions',
      transactionLog: [],
      dbId: databaseId,
      dbNameHash: database.dbNameHash,
      isOwner: database.isOwner,
    }

    const reopeningDatabase = reopenAtSeqNo !== undefined

    const openingDatabase = dbNameHash && dbKey && !reopeningDatabase
    if (openingDatabase) {
      payload.dbNameHash = dbNameHash
      payload.dbKey = dbKey
    }

    let lastSeqNo = database.lastSeqNo
    const bundleSeqNo = database.bundleSeqNo

    if (bundleSeqNo > 0 && database.lastSeqNo === 0) {
      const bundle = await db.getBundle(databaseId, bundleSeqNo)
      payload.bundleSeqNo = bundleSeqNo
      payload.bundle = bundle
      lastSeqNo = bundleSeqNo
    }

    // get transactions from the last sequence number
    const params = {
      TableName: setup.transactionsTableName,
      KeyConditionExpression: "#dbId = :dbId and #seqNo > :seqNo",
      ExpressionAttributeNames: {
        "#dbId": "database-id",
        "#seqNo": "sequence-no"
      },
      ExpressionAttributeValues: {
        ":dbId": databaseId,
        ":seqNo": lastSeqNo
      }
    }

    const ddbTransactionLog = []
    try {
      const ddbClient = connection.ddbClient()
      let gapInSeqNo = false

      do {
        let transactionLogResponse = await ddbClient.query(params).promise()

        if (transactionLogResponse.Items.length) {
          const lastSeqNoInBatch = transactionLogResponse.Items[transactionLogResponse.Items.length - 1]['sequence-no']

          if (database.lastSeqNo < lastSeqNoInBatch) {

            for (let i = 0; i < transactionLogResponse.Items.length && !gapInSeqNo; i++) {

              // if there's a gap in sequence numbers and past rollback buffer, rollback all transactions in gap
              gapInSeqNo = transactionLogResponse.Items[i]['sequence-no'] > lastSeqNo + 1
              const secondsSinceCreation = gapInSeqNo && new Date() - new Date(transactionLogResponse.Items[i]['creation-date'])

              // waiting gives opportunity for item to insert into DDB
              if (gapInSeqNo && secondsSinceCreation > SECONDS_BEFORE_ROLLBACK_GAP_TRIGGERED) {
                const rolledBackTransactions = await this.rollback(lastSeqNo, transactionLogResponse.Items[i]['sequence-no'], databaseId, ddbClient)

                for (let j = 0; j < rolledBackTransactions.length; j++) {

                  // add transaction to the result set if have not sent it to client yet
                  if (rolledBackTransactions[j]['sequence-no'] > database.lastSeqNo) {
                    ddbTransactionLog.push(rolledBackTransactions[j])
                  }

                }
              } else if (gapInSeqNo) {
                // at this point must stop querying for more transactions
                continue
              }

              lastSeqNo = transactionLogResponse.Items[i]['sequence-no']

              // add transaction to the result set if have not sent it to client yet
              if (transactionLogResponse.Items[i]['sequence-no'] > database.lastSeqNo) {
                ddbTransactionLog.push(transactionLogResponse.Items[i])
              }

            }
          }
        }

        // paginate over all results
        params.ExclusiveStartKey = transactionLogResponse.LastEvaluatedKey
      } while (params.ExclusiveStartKey && !gapInSeqNo)

    } catch (e) {
      logger.warn(`Failed to push to ${databaseId} with ${e}`)
      throw new Error(e)
    }

    if (openingDatabase && database.lastSeqNo !== 0) {
      logger
        .child({ databaseId, connectionId: this.id })
        .warn('When opening database, must send client entire transaction log from tip')
      return
    }

    if (reopeningDatabase && database.lastSeqNo !== reopenAtSeqNo) {
      logger
        .child({ databaseId, connectionId: this.id })
        .warn('When reopening database, must send client entire transaction log from requested seq no')
      return
    }

    if (!openingDatabase && !database.init) {
      logger
        .child({ databaseId, connectionId: this.id })
        .warn('Must finish opening database before sending transactions to client')
      return
    }

    if (!ddbTransactionLog || ddbTransactionLog.length == 0) {
      if (openingDatabase || reopeningDatabase) {
        const msg = JSON.stringify(payload)
        this.socket.send(msg)

        if (payload.bundle) {
          database.lastSeqNo = payload.bundleSeqNo
        }

        database.init = true

        logger
          .child({
            connectionId: this.id,
            userId: this.userId,
            adminId: this.adminId,
            databaseId: payload.dbId,
            route: payload.route,
            size: msg.length,
            bundleSeqNo: payload.bundleSeqNo,
            seqNo: database.lastSeqNo
          })
          .info('Sent initial transactions to client')
      }
      return
    }

    this.sendPayload(payload, ddbTransactionLog, database)
  }

  async rollback(lastSeqNo, thisSeqNo, databaseId, ddbClient) {
    const rolledBackTransactions = []

    for (let i = lastSeqNo + 1; i <= thisSeqNo - 1; i++) {
      const rolledbBackItem = {
        'database-id': databaseId,
        'sequence-no': i,
        'command': 'Rollback',
        'creation-date': new Date().toISOString()
      }

      const rollbackParams = {
        TableName: setup.transactionsTableName,
        Item: rolledbBackItem,
        ConditionExpression: 'attribute_not_exists(#databaseId)',
        ExpressionAttributeNames: {
          '#databaseId': 'database-id'
        }
      }

      await ddbClient.put(rollbackParams).promise()

      rolledBackTransactions.push(rolledbBackItem)
    }

    return rolledBackTransactions
  }

  sendPayload(payload, ddbTransactionLog, database) {
    let size = 0

    // only send transactions that have not been sent to client yet
    const indexOfFirstTransactionToSend = ddbTransactionLog.findIndex(transaction => {

      // check database.lastSeqNo bc could have been overwitten while DDB was paginating
      return transaction['sequence-no'] > database.lastSeqNo
    })

    if (indexOfFirstTransactionToSend === -1) return

    const transactionLog = ddbTransactionLog
      .slice(indexOfFirstTransactionToSend)
      .map(transaction => {
        size += estimateSizeOfDdbItem(transaction)

        return {
          seqNo: transaction['sequence-no'],
          command: transaction['command'],
          key: transaction['key'],
          record: transaction['record'],
          fileMetadata: transaction['file-metadata'],
          fileId: transaction['file-id'],
          fileEncryptionKey: transaction['file-encryption-key'],
          operations: transaction['operations'],
          dbId: transaction['database-id']
        }
      })

    if (transactionLog.length === 0) return

    // only send the payload if tx log starts with the next seqNo client is supposed to receive
    const startSeqNo = transactionLog[0]['seqNo']
    if (startSeqNo !== database.lastSeqNo + 1
      && startSeqNo !== payload.bundleSeqNo + 1) return

    let msg
    const buildBundle = database.transactionLogSize + size >= TRANSACTION_SIZE_BUNDLE_TRIGGER
    if (buildBundle) {
      msg = JSON.stringify({ ...payload, transactionLog, buildBundle: true })
      this.socket.send(msg)
      database.transactionLogSize = 0
    } else {
      msg = JSON.stringify({ ...payload, transactionLog })
      this.socket.send(msg)
      database.transactionLogSize += size
    }

    // database.lastSeqNo should be strictly increasing
    const endSeqNo = transactionLog[transactionLog.length - 1]['seqNo']
    database.lastSeqNo = endSeqNo
    database.init = true

    logger
      .child({
        connectionId: this.id,
        userId: this.userId,
        adminId: this.adminId,
        databaseId: payload.dbId,
        route: payload.route,
        size: msg.length,
        bundleSeqNo: payload.bundleSeqNo,
        transactionLogSize: database.transactionLogSize,
        buildBundle,
        startSeqNo,
        endSeqNo
      })
      .info('Sent transactions to client')
  }
}

export default class Connections {
  static register(userId, socket, clientId, adminId, appId) {
    if (!Connections.sockets) Connections.sockets = {}
    if (!Connections.sockets[userId]) Connections.sockets[userId] = { numConnections: 0, fileIds: {} }
    if (!Connections.sockets[adminId]) Connections.sockets[adminId] = { numConnections: 0 }
    if (!Connections.sockets[appId]) Connections.sockets[appId] = { numConnections: 0 }

    if (!Connections.uniqueClients) Connections.uniqueClients = {}
    if (!Connections.uniqueClients[clientId]) {
      Connections.uniqueClients[clientId] = true
    } else {
      logger.child({ userId, clientId, adminId }).warn('User attempted to open multiple socket connections from client')
      socket.close(statusCodes['Client Already Connected'])
      return false
    }

    const connection = new Connection(userId, socket, clientId, adminId, appId)

    Connections.sockets[userId][connection.id] = connection
    Connections.sockets[userId].numConnections += 1

    Connections.sockets[adminId][connection.id] = userId
    Connections.sockets[adminId].numConnections += 1

    Connections.sockets[appId][connection.id] = userId
    Connections.sockets[appId].numConnections += 1

    logger.child({ connectionId: connection.id, userId, clientId, adminId, appId }).info('WebSocket connected')

    return connection
  }

  static openDatabase(userId, connectionId, databaseId, bundleSeqNo, dbNameHash, dbKey, reopenAtSeqNo, isOwner) {
    if (!Connections.sockets || !Connections.sockets[userId] || !Connections.sockets[userId][connectionId]) return

    const conn = Connections.sockets[userId][connectionId]

    if (!conn.databases[databaseId]) {
      conn.openDatabase(databaseId, dbNameHash, bundleSeqNo, reopenAtSeqNo, isOwner)
      logger.child({ connectionId, databaseId, adminId: conn.adminId }).info('Database opened')
    }

    conn.push(databaseId, dbNameHash, dbKey, reopenAtSeqNo)

    if (!Connections.sockets[databaseId]) Connections.sockets[databaseId] = { numConnections: 0 }
    Connections.sockets[databaseId][connectionId] = userId
    Connections.sockets[databaseId].numConnections += 1

    return true
  }

  static isDatabaseOpen(userId, connectionId, databaseId) {
    if (!Connections.sockets || !Connections.sockets[userId] || !Connections.sockets[userId][connectionId]) return

    const conn = Connections.sockets[userId][connectionId]

    return conn.databases[databaseId] ? true : false
  }

  static push(transaction) {
    const dbId = transaction['database-id']
    if (!Connections.sockets || !Connections.sockets[dbId]) return

    for (const connectionId in Connections.sockets[dbId]) {
      const userId = Connections.sockets[dbId][connectionId]

      if (Connections.sockets[userId] && Connections.sockets[userId][connectionId]) {
        const conn = Connections.sockets[userId][connectionId]
        const database = conn.databases[dbId]

        // don't need to requery DDB if sending transaction with the next sequence no
        if (database && transaction['sequence-no'] === database.lastSeqNo + 1) {
          const payload = {
            route: 'ApplyTransactions',
            dbId,
            dbNameHash: database.dbNameHash,
            isOwner: database.isOwner,
          }

          conn.sendPayload(payload, [transaction], database)
        } else {
          conn.push(transaction['database-id'])
        }
      }
    }
  }

  static close(connection) {
    const { userId, id, clientId, adminId, appId } = connection
    const connectionId = id

    logger.child({ userId, connectionId, clientId, adminId, appId }).info('WebSocket closing')

    for (const dbId in Connections.sockets[userId][connectionId].databases) {
      delete Connections.sockets[dbId][connectionId]
      Connections.sockets[dbId].numConnections -= 1
      if (Connections.sockets[dbId].numConnections === 0) delete Connections.sockets[dbId]
    }

    delete Connections.sockets[userId][connectionId]
    Connections.sockets[userId].numConnections -= 1
    if (Connections.sockets[userId].numConnections === 0) delete Connections.sockets[userId]

    delete Connections.sockets[adminId][connectionId]
    Connections.sockets[adminId].numConnections -= 1
    if (Connections.sockets[adminId].numConnections === 0) delete Connections.sockets[adminId]

    delete Connections.sockets[appId][connectionId]
    Connections.sockets[appId].numConnections -= 1
    if (Connections.sockets[appId].numConnections === 0) delete Connections.sockets[appId]

    delete Connections.uniqueClients[clientId]
  }

  static closeUsersConnectedClients(userId) {
    if (!Connections.sockets || !Connections.sockets[userId]) return

    for (const conn of Object.values(Connections.sockets[userId])) {
      conn.socket.close()
    }
  }

  static closeAppsConnectedClients(appId) {
    if (!Connections.sockets || !Connections.sockets[appId]) return

    for (const userId of Object.values(Connections.sockets[appId])) {
      this.closeUsersConnectedClients(userId)
    }
  }

  static closeAdminsConnectedClients(adminId) {
    if (!Connections.sockets || !Connections.sockets[adminId]) return

    for (const userId of Object.values(Connections.sockets[adminId])) {
      this.closeUsersConnectedClients(userId)
    }
  }

  static cacheFileId(userId, fileId) {
    if (!Connections.sockets || !Connections.sockets[userId] || !Connections.sockets[userId].fileIds) return

    // after FILE_ID_CACHE_LIFE seconds, delete the fileId from the cache
    Connections.sockets[userId].fileIds[fileId] = setTimeout(() => {
      if (Connections.sockets && Connections.sockets[userId] && Connections.sockets[userId].fileIds) {
        delete Connections.sockets[userId].fileIds[fileId]
      }
    },
      FILE_ID_CACHE_LIFE
    )
  }

  static isFileIdCached(userId, fileId) {
    if (!Connections.sockets || !Connections.sockets[userId] || !Connections.sockets[userId].fileIds || !Connections.sockets[userId].fileIds[fileId]) return false

    // reset the cache
    clearTimeout(Connections.sockets[userId].fileIds[fileId])
    this.cacheFileId(userId, fileId)
    return true
  }
}
