const mpack          = require('what-the-pack'),
      serializeError = require('serialize-error'),
      through        = require('through'),
      stream         = Symbol(),
      history        = Symbol(),
      txid           = Symbol(),
      rxid           = Symbol();

// Remotely-thrown errors will be of this class
class RemoteError extends Error {
  constructor(data) {
    super();
    Object.assign(this, data);
  }
}

// Generate a safe ID to use
function genId() {
  let out = '';
  while (out.length < 48) {
    out += (Math.random() * 36 * 36).toString(36).substr(0, 2);
  }
  return out;
}

function send(stream, data, nack) {

  // Prepend txid & save for retransmission
  // nacks are raw, don't prepend
  if (!(txid    in stream)) stream[txid]    = 0;
  if (!(history in stream)) stream[history] = [];
  stream[history][stream[txid]] = data.slice()
  data = Buffer.concat([Buffer.from([stream[txid]]),data]);
  stream[txid] = (stream[txid]+1) % 128;

  // Nack = flagged
  if(nack) {
    data[0] |= 128;
  }

  // Send the data
  if (stream.queue) {
    stream.queue(data);
  } else {
    stream.emit('data', data);
  }
}

async function acknack(stream, data) {
  if (!(rxid    in stream)) stream[rxid]    = 0;
  let rid = data[0] % 128,
      ret = data.slice(1);

  // Ask retransmission if unexpected txid
  while (stream[rxid] !== rid) {
    send(stream,Buffer.from([stream[rxid]++]),true);
  }

  // If NACK, retransmit if available
  if (data[0]&128) {

    // Retransmit
    let rtid = data[1] % 128;
    if (rtid in stream[history]) {
      send(stream,stream[history][rtid]);
    }

    // Delete old history
    let cid = rtid-1;
    while(cid in stream[history]) {
      delete stream[history][cid];
      cid--;
      if(cid<0) cid += 128
    }

    // Update expected id
    stream[rxid] = (rid+1) % 128;
    return false;
  }

  stream[rxid] = (rid+1) % 128;
  return ret;
}

// Serializes an object into something safe
function encodeState(state, out, path, includeFn) {
  path = path || [];
  out  = out || [];
  Object.keys(state).forEach(function(key) {
    let current = [path.concat([key]), typeof state[key]];
    switch (current[1]) {
      case 'function':
        if (includeFn) current.push(state[key]);
        out.push(current);
        encodeState(state[key], out, path.concat([key]));
        break;
      case 'object':
        if (null === state[key]) {
          current[1] = 'null';
          out.push(current);
          break;
        }
        if (Array.isArray(state[key])) {
          current[1] = 'array';
        }
        out.push(current);
        encodeState(state[key], out, path.concat([key]));
        break;
      default:
        current.push(state[key]);
        out.push(current);
        break;
    }
  });
  return out;
}

// Make the args safe
function serializeArgs(local, data) {
  let serialized = encodeState(data, [], [], true);
  serialized.forEach(function(token) {
    switch(token[1]) {
      case 'function':
        let id = genId();
        local[id] = token[2];
        token[2]  = id;
        break;
    }
  });
  return serialized;
}

// Decode the safe args
// TODO: create decodeState function
function deserializeArgs(local, data) {
  let out = [];
  data.forEach(function(token) {
    let [path, type, value] = token;
    let ref                 = out;
    let lastKey             = path.pop();
    for (const key of path) {
      ref = ref[key] = ref[key] || {};
    }
    switch(type) {
      case 'null':
        ref[lastKey] = null;
        break;
      case 'object':
        if ('object' !== typeof ref[lastKey]) {
          ref[lastKey] = {};
        }
        return;
      case 'array':
        if (!Array.isArray(ref[lastKey])) {
          ref[lastKey] = [];
        }
        return;
      case 'function':
        ref[lastKey] = function (...args) {
          return new Promise((resolve, reject) => {
            let resolveId      = genId(),
                rejectId       = genId();
            local[resolveId] = function (data) {
              delete local[resolveId];
              delete local[rejectId];
              resolve(data);
            };
            local[rejectId]  = function (data) {
              delete local[resolveId];
              delete local[rejectId];
              reject(new RemoteError(data));
            };
            send(local[stream], mpack.encode({
              fn : [value],
              arg: serializeArgs(local, args),
              ret: [resolveId],
              err: [rejectId]
            }));
          });
        };
        return;
      default:
        if (value !== ref[lastKey]) {
          ref[lastKey] = value;
        }
        return;
    }
  });
  return out;
}

function injectStream( obj, s ) {
  if (!obj) return;
  if (!s) return;
  if ('object' === typeof obj) {
    Object.defineProperty(obj, stream, {
      enumerable  : false,
      configurable: true,
      get         : () => s,
      set         : () => {},
    });
  }
  for (let prop in obj) {
    if (!obj.hasOwnProperty(prop)) continue;
    if (prop === stream) continue;
    switch (typeof obj[prop]) {
      case 'object':
      case 'function':
        if (!obj[prop]) continue;
        Object.defineProperty(obj[prop], stream, {
          enumerable  : false,
          configurable: true,
          get         : () => s,
          set         : () => {},
        });
        break;
    }
  }
}

// Turn object into stream
let rpc = module.exports = function (local, remote) {
  let s = through(async function incoming(data) {
    if (!data) return;
    data = await acknack(s,data);
    if (!data) return;
    data = mpack.decode(data);

    // Respond to state request
    if ('state' === data.fn) {
      send(s, mpack.encode({
        fn : 'update',
        arg: serializeArgs(s.local, [
          encodeState(s.local)
        ])
      }));
      return;
    }

    // State update
    // TODO: create decodeState function
    if ('update' === data.fn) {
      let [remoteState] = deserializeArgs(s.local, data.arg);
      for (let remoteProp of remoteState) {
        let ref                   = s.remote;
        const [path, type, value] = remoteProp;
        const lastKey             = path.pop();
        for (let key of path) {
          ref = ref[key] = ref[key] || {};
        }
        switch (type) {
          case 'null':
            ref[lastKey] = null;
            break;
          case 'object':
            if ('object' !== typeof ref[lastKey]) {
              ref[lastKey] = {};
              Object.defineProperty(ref[lastKey], stream, {
                enumerable  : false,
                configurable: true,
                get         : () => s,
                set         : () => {},
              });
            }
            continue;
          case 'array':
            if (!Array.isArray(ref[lastKey])) {
              ref[lastKey] = [];
            }
            continue;
          case 'function':
            if ('function' !== typeof ref[lastKey]) {
              let fullPath = path.concat([lastKey]);
              ref[lastKey] = async function (...args) {
                return new Promise((resolve, reject) => {
                  let resolveId      = genId(),
                      rejectId       = genId();
                  s.local[resolveId] = function (data) {
                    delete s.local[resolveId];
                    delete s.local[rejectId];
                    resolve(data);
                  };
                  s.local[rejectId]  = function (data) {
                    delete s.local[resolveId];
                    delete s.local[rejectId];
                    reject(new RemoteError(data));
                  };
                  send(s, mpack.encode({
                    fn : fullPath,
                    arg: serializeArgs(s.local, args),
                    ret: [resolveId],
                    err: [rejectId]
                  }));
                });
              };
            }
            continue;
          default:
            if (value !== ref[lastKey]) {
              ref[lastKey] = value;
            }
            continue;
        }
      }
      injectStream(remote,s);
      return;
    }

    // Actual function call
    if (Array.isArray(data.fn)) {
      let target = s.local;
      for (let key of data.fn) {
        target = target[key] || {};
      }
      if ('function' === typeof target) {
        try {
          let result = await target(...deserializeArgs(s.local, data.arg));
          if (data.ret) {
            send(s, mpack.encode({
              fn : data.ret,
              arg: serializeArgs(s.local, [result])
            }));
          }
        } catch (e) {
          if (data.err) {
            send(s, mpack.encode({
              fn : data.err,
              arg: serializeArgs(s.local, [serializeError(e)])
            }));
          }
        }
        return;
      }
    }

    // Maybe extend here
  });

  // Keep track of structure
  s.local  = local  || {};
  s.remote = remote || {};

  // Allow the update the fetch the stream
  injectStream(s.local,s);
  injectStream(s.remote,s);

  return s;
};

// Turn stream into object
rpc.from = function (s) {
  // Signal we want the state
  send(s, mpack.encode({fn: 'state'}));
  return s.remote;
};

// Requests a state update
rpc.update = function (local) {
  if(!local[stream]) return;
  send(local[stream], mpack.encode({fn: 'state'}));
};

// Send a state update
rpc.updateRemote = function (local) {
  if(!local[stream]) return;
  injectStream(local,local[stream]);
  send(local[stream], mpack.encode({
    fn : 'update',
    arg: serializeArgs(local[stream].local, [
      encodeState(local[stream].local)
    ])
  }));
};
