'use strict'

const debug = require('debug')
const log = debug('multiplex')
log.error = debug('multiplex:error')

const lp = require('pull-length-prefixed')
const batch = require('pull-batch')
const pullCatch = require('pull-catch')
const pull = require('pull-stream')
const many = require('pull-many')
const abortable = require('pull-abortable')
const EventEmitter = require('events').EventEmitter
const pair = require('pull-pair')

const pullEnd = require('./pull-end')
const pullSwitch = require('./pull-switch')
const utils = require('./utils')

const SIGNAL_FLUSH = new Buffer([0])

function InChannel (id, name) {
  if (name == null) {
    name = id.toString()
  }

  const p = pair()
  const aborter = abortable()

  return {
    abort: aborter.abort.bind(aborter),
    p: p,
    source: pull(
      p.source,
      aborter,
      pull.map((input) => {
        const header = utils.readHeader(input[0])
        const data = input[1]

        const flag = header.flag
        const remoteId = header.id
        const isLocal = flag & 1
        log('in', {header, data, flag, id, isLocal, remoteId})
        switch (flag) {
          case 0: // open
            return pull.empty()
          case 1: // local packet
          case 2: // remote packet
            return pull.values([data])
          case 3: // local end
          case 4: // remote end
            return pull.empty()
          case 5: // local error
          case 6: // remote error
            return pull.error(
              new Error(data.toString() || 'Channel destroyed')
            )
          default:
            return pull.empty()
        }
      }),
      pull.flatten()
    )
  }
}

function OutChannel (id, name, open) {
  if (name == null) {
    name = id.toString()
  }

  let flag = 2
  open = false
  const p = pair()

  const wrap = (data) => {
    // TODO: assert data < 1MB
    return [
      utils.createHeader(id, flag),
      Buffer.isBuffer(data) ? data : new Buffer(data)
    ]
  }

  return {
    p: p,
    sink: pull(
      pullEnd(() => {
        log('local end', id)
        flag = 3
        return SIGNAL_FLUSH
      }),
      pullCatch((err) => {
        log('local error', id, err.message)
        flag = 5
        return SIGNAL_FLUSH
      }),
      pull.map((data) => {
        log('out', {data, open, id})
        if (!open) {
          open = true
          return pull.values([
            utils.createHeader(id, 0),
            Buffer.isBuffer(name) ? name : new Buffer(name)
          ].concat(wrap(data)))
        }

        return pull.values(wrap(data))
      }),
      pull.flatten(),
      pull.through((d) => log('out', d)),
      p.sink
    )
  }
}

class Channel {
  constructor (id, name, open) {
    this.id = id
    this.name = name == null ? id.toString() : name

    log('new channel', {id, name})

    this.outChan = new OutChannel(id, name, open)
    this.sink = this.outChan.sink

    this.inChan = new InChannel(id, name)
    this.source = pull(this.inChan.source, pull.through((d) => log('in out', d)))
  }
}

class Multiplex extends EventEmitter {
  constructor (opts) {
    log('multiplex create')
    super()
    opts = opts || {}

    this._options = opts

    this._localIds = 0

    this._streams = {}

    // TODO: only encode/decode data chunks, not headers
    this.sink = pull(
      lp.decode(),
      pull.through((d) => log('incoming', d)),
      batch(2),
      pullEnd(() => {
        this.emit('close')
      }),
      pullSwitch(this._split.bind(this))
    )

    this._many = many()
    this.source = pull(
      this._many,
      lp.encode()
    )
  }

  _split (input) {
    const header = utils.readHeader(input[0])
    const data = input[1]

    const id = header.id
    const flag = header.flag

    log('split', {header, data, flag, id})
    // open
    if (flag === 0) {
      log('opening', id)
      let channel = this._streams[id]
      if (!channel) {
        log('no channel', id)
        channel = new Channel(id, null, true)
        this._streams[id] = channel
        this._many.add(channel.outChan.p.source)
      }

      this.emit('stream', channel, id)

      return channel.inChan.p.sink
    }

    // close or error
    if ([3, 4, 5, 6].indexOf(flag) > -1) {
      const c = this._streams[id]
      this._streams[id] = null

      // error
      if (flag > 4) {
        const msg = data.toString() || 'Channel destroyed'
        const err = new Error(msg)

        c.inChan.abort(err)
        this.emit('error', err)
      } else {
        // end
        c.inChan.abort()
      }

      return
    }

    return this._streams[id].inChan.p.sink
  }

  _nextId (initiator) {
    const id = this._localIds
    this._localIds += 2

    if (initiator) {
      return id + 1
    }

    return id
  }

  createStream (id, name, opts) {
    id = id == null ? this._nextId(true) : id
    log('create stream', {id, name})

    const channel = new Channel(id, name)

    this._streams[id] = channel
    this._many.add(channel.outChan.p.source)

    return channel
  }

  destroy (callback) {
    if (callback) {
      this.on('close', callback)
    }

    // TODO: How to do this best?
    // this._streams.forEach((s) => s.close())
  }
}

module.exports = Multiplex
exports.Channel = Channel
