const mpack          = require('what-the-pack'),
      serializeError = require('serialize-error'),
      through        = require('through'),
      stream         = Symbol();

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
            local[stream].emit('data', mpack.encode({
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

// Turn object into stream
let rpc = module.exports = function (obj, virtual) {
  let s = through(async function incoming(data) {
    if (!data) return;
    data = mpack.decode(data);

    // Respond to state request
    if ('state' === data.fn) {
      s.emit('data', mpack.encode({
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
              ref[lastKey] = function (...args) {
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
                  s.emit('data', mpack.encode({
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
            s.emit('data', mpack.encode({
              fn : data.ret,
              arg: serializeArgs(s.local, [result])
            }));
          }
        } catch (e) {
          if (data.err) {
            s.emit('data', mpack.encode({
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
  s.local  = obj || {};
  s.remote = virtual ? Object.create(virtual) : {};

  // Allow the update the fetch the stream
  Object.defineProperty(s.local, stream, {
    enumerable  : false,
    configurable: true,
    get         : () => s,
    set         : () => {},
  });
  Object.defineProperty(s.remote, stream, {
    enumerable  : false,
    configurable: true,
    get         : () => s,
    set         : () => {},
  });

  return s;
};

// Turn stream into object
rpc.from = function (s) {
  // Signal we want the state
  s.emit('data', mpack.encode({fn: 'state'}));
  return s.remote;
};

// Requests a state update
rpc.update = function (local) {
  local[stream].emit('data', mpack.encode({fn: 'state'}));
};

// Send a state update
rpc.updateRemote = function (local) {
  local[stream].emit('data', mpack.encode({
    fn : 'update',
    arg: serializeArgs(local[stream].local, [
      encodeState(local[stream].local)
    ])
  }));
};
