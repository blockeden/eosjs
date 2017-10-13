const ecc = require('eosjs-ecc')
const Fcbuffer = require('fcbuffer')
const createHash = require('create-hash')
const {processArgs} = require('eosjs-api')
const Structs = require('./structs')
const assert = require('assert')

module.exports = writeApiGen

const {sign} = ecc

function writeApiGen(Network, network, structs, config) {
  let merge = {}

  if(typeof config.chainId !== 'string') {
    throw new TypeError('config.chainId is required')
  }

  /**
    @arg {object} transaction
    @arg {object} [options]
    @arg {function} [callback]
  */
  merge.transaction = (...args) => {
    let options, callback
    if(args.length > 1 && typeof args[args.length - 1] === 'function') {
      callback = args.pop()
    }

    if(args.length > 1 && typeof args[args.length - 1] === 'object') {
      options = args.pop()
    }

    assert.equal(args.length, 1, 'Transaction args: transaction, [options], [callback]')
    return transaction(args[0], options, network, structs, config, merge, callback)
  }

  for(let type in Network.schema) {
    if(!/^[a-z]/.test(type)) {
      // Only lower case structs will work in a transaction message
      // See eosjs-json generated.json
      continue
    }

    if(type === 'transaction') {
      new TypeError('Conflicting Api function: transaction')
    }

    const struct = structs[type]
    const definition = Network.schema[type]
    merge[type] = genMethod(type, definition, struct, merge.transaction, Network)
  }

  return merge
}

function genMethod(type, definition, struct, transactionArg, Network) {
  return function (...args) {
    if (args.length === 0) {
      console.error(usage(type, definition, Network))
      return
    }

    // Special case like multi-message transactions where this lib needs
    // to be sure the broadcast is off.
    const optionOverrides = {}
    const lastArg = args[args.length - 1]
    if(typeof lastArg === 'object' && typeof lastArg.__optionOverrides === 'object') {
      // pop() fixes the args.length
      Object.assign(optionOverrides, args.pop().__optionOverrides)
    }

    // Normalize the extra optional options argument
    const optionsFormatter = option => {
      if(typeof option === 'object') {
        return option // {debug, broadcast, scope, etc} (scope, etc my overwrite tr below)
      }
      if(typeof option === 'boolean') {
        // broadcast argument as a true false value, back-end cli will use this shorthand
        return {broadcast: option}
      }
    }
    const {params, options, returnPromise, callback} =
      processArgs(args, Object.keys(definition.fields), type, optionsFormatter)

    // internal options (ex: multi-message transaction)
    Object.assign(options, optionOverrides)

    if(optionOverrides.noCallback && !returnPromise) {
      throw new Error('Callback during a transaction are not supported')
    }

    const tr = Object.assign(
      {
        messages: [{
          code: 'eos',
          type,
          data: params,
          authorization: []
        }]
      }
    )

    if(!tr.scope) {// FIXME Hack, until an API call is available
      const fields = Object.keys(definition.fields)
      tr.scope = []

      const f1 = fields[0]
      if(definition.fields[f1] === 'AccountName') {
        tr.scope.push(params[f1])
        tr.messages[0].authorization.push({
          account: params[f1],
          permission: 'active'
        })
      }

      if(fields.length > 1 && !/newaccount/.test(type)) {
        const f2 = fields[1]
        if(definition.fields[f2] === 'AccountName') {
          tr.scope.push(params[f2])
        }
      }
    }
    tr.scope = tr.scope.sort()

    // multi-message transaction support
    if(!optionOverrides.messageOnly) {
      transactionArg(tr, options, callback)
    } else {
      callback(null, tr)
    }

    return returnPromise
  }
}

/**
  @args {object} args {
    scope: [],
    messages: [{}, ..]
  }
  @args {object} options {
    [expireInSeconds = 60],
    [broadcast = true],
    [sign = true]
  }
*/
function transaction(arg, options, network, structs, config, merge, callback) {
  const optionDefault = {expireInSeconds: 60, broadcast: true, sign: true}
  options = Object.assign({}/*clone*/, optionDefault, options)

  let returnPromise
  if(typeof callback !== 'function') {
    returnPromise = new Promise((resolve, reject) => {
      callback = (err, result) => {
        if(err) {
          reject(err)
        } else {
          resolve(result)
        }
      }
    })
  }

  if(typeof arg === 'function') {
    const cbPromis = atomicTransaction(arg, options, merge, callback)
    return returnPromise ? returnPromise : cbPromis
  }

  if(typeof arg !== 'object') {
    throw new TypeError('First transaction argument should be an object or function')
  }

  if(!Array.isArray(arg.scope)) {
    throw new TypeError('Expecting scope array')
  }
  if(!Array.isArray(arg.messages)) {
    throw new TypeError('Expecting messages array')
  }

  arg.messages.forEach(message => {
    if(!Array.isArray(message.authorization) || message.authorization.length === 0) {
      throw new TypeError('Expecting message.authorization array', message)
    }
  })

  if(options.sign && typeof config.signProvider !== 'function') {
    throw new TypeError('Expecting config.signProvider function (disable using {sign: false})')
  }

  network.createTransaction(options.expireInSeconds, checkError(callback, rawTx => {
    rawTx.scope = arg.scope
    rawTx.messages = arg.messages
    rawTx.readscope = arg.readscope || []

    const {Transaction} = structs
    const txObject = Transaction.fromObject(rawTx)// resolve shorthand
    const buf = Fcbuffer.toBuffer(Transaction, txObject)

    // console.log('txObject', JSON.stringify(txObject,null,4))

    // Broadcast what is signed (instead of rawTx)
    const tr = Fcbuffer.fromBuffer(Transaction, buf)

    let sigs = []
    if(options.sign){
      const chainIdBuf = new Buffer(config.chainId, 'hex')
      const signBuf = Buffer.concat([chainIdBuf, buf])
      sigs = config.signProvider({transaction: tr, buf: signBuf, sign})
      if(!Array.isArray(sigs)) {
        sigs = [sigs]
      }
    }

    // sigs can be strings or Promises
    Promise.all(sigs).then(sigs => {
      sigs = [].concat.apply([], sigs) //flatten arrays in array
      tr.signatures = sigs

      console.log(JSON.stringify(tr, null, 4))// DEBUG

      if(!options.broadcast) {
        callback(null, tr)
      } else {
        network.pushTransaction(tr, error => {
          if(!error) {
            callback(null, tr)
          } else {
            console.error(`[push_transaction error] '${error.message}', digest '${buf.toString('hex')}'`)
            callback(error.message)
          }
        })
      }
    }).catch(error => {
      console.error(error)
      callback(error)
    })
  }))
  return returnPromise
}


function atomicTransaction(tr, options, merge, callback) {
  assert.equal(typeof tr, 'function', 'tr')
  assert.equal(typeof options, 'object', 'options')

  const scope = {}
  const messageList = []
  const messageCollector = {}

  for(let op in merge) {
    messageCollector[op] = (...args) => {
      // call the original function but force-disable a lot of stuff
      const opFunction = merge[op]
      const ret = opFunction(...args, {
        __optionOverrides: {
          broadcast: false,
          messageOnly: true,
          noCallback: true
        }
      })

      if(ret == null) {
        // double-check (code can change)
        throw new Error('Callbacks can not be used when creating a multi-message transaction')
      }
      messageList.push(ret)
    }
  }

  let collectorPromise
  try {
    // caller will load this up with messages
    collectorPromise = tr(messageCollector)
  } catch(error) {
    collectorPromise = Promise.reject(error)
  }

  Promise.resolve(collectorPromise).then(() => {
    return Promise.all(messageList).then(resolvedMessageList => {
      const scopes = new Set()
      const messages = []
      for(let m of resolvedMessageList) {
        const {scope, messages: [message]} = m
        scope.forEach(s => {scopes.add(s)})
        messages.push(message)
      }
      const trObject = {}
      trObject.scope = Array.from(scopes).sort()
      trObject.messages = messages
      merge.transaction(trObject, options, callback)

    })
  }).catch(error => {
    // console.error(error)
    callback(error)
  })
}

function usage (type, definition, Network) {
  const {structs} = Structs({defaults: true, network: Network})
  const struct = structs[type]

  if(struct == null) {
    throw TypeError('Unknown type: ' + type)
  }

  let usage = ''
  const out = (str = '') => {
    usage += str + '\n'
  }
  out(`${type}`)
  out()

  out(`USAGE`)
  out(`${JSON.stringify(definition, null, 4)}`)
  out()

  out(`EXAMPLE STRUCTURE`)
  out(`${JSON.stringify(struct.toObject(), null, 4)}`)

  return usage
}


const checkError = (parentErr, parrentRes) => (error, result) => {
  if (error) {
    console.log('error', error)
    parentErr(error)
  } else {
    parrentRes(result)
  }
}