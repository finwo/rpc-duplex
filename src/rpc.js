const through   = require('through'),
      packetize = require('stream-packetize'),
      serializeError = require('serialize-error'),
      nagle     = require('stream-nagle'),
      mpack     = require('what-the-pack'),
      stream    = Symbol();

// Generate a safe ID to use
function genId() {
  let out = '';
  while (out.length < 48)
    out += (Math.random() * 36 * 36).toString(36).substr(0, 2);
  return out;
}

// Remotely-thrown errors will be of this class
class RemoteError extends Error {
  constructor(data) {
    super();
    Object.assign(this, data);
  }
}

// Attach the stream everywhere in the ref
function attachStream( obj, s ) {
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

function serialize( data, out, path, includeFn ) {
  out      = out  || [];
  path     = path || [];
  let type = 1;
  Object.keys(data).forEach(function(key) {
    let current = [path.concat([key]), typeof data[key]];
    switch(current[type]) {
      case 'function':
        if (includeFn) current.push(data[key]);
        out.push(current);
        serialize(data[key], out, path.concat([key]), includeFn);
        break;
      case 'object':

        // null = object
        if (null === data[key]) {
          current[type] = 'null';
          out.push(current);
          break;
        }

        // Identify arrays
        if (Array.isArray(data[key])) {
          current[type] = 'array';
        }

        // Iterate down
        out.push(current);
        serialize(data[key], out, path.concat([key]), includeFn);
        break;
      default:
        current.push(data[key]);
        out.push(current);
        break;
    }
  });
  return out;
}

function deserialize( ref, data, obj ) {
  obj   = obj || {};
  let s = ref[stream];
  data.forEach(function(token) {

    // Destructure the token
    let [path, type, value] = token;
    let ref                 = obj;
    let lastKey             = path.pop();

    // Get the proper reference
    for (const key of path) {
      ref = ref[key] = ref[key] || {};
    }

    // Fetch what to do
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
        if (!value) value = path.concat([lastKey]);
        if (!Array.isArray(value)) value = [value];
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
            s.output.write(mpack.encode({
              fn : value,
              arg: serializeArgs(s, args),
              ret: [resolveId],
              err: [rejectId]
            }));
          });
        };
        break;
      default:
        if (value !== ref[lastKey]) {
          ref[lastKey] = value;
        }
        return;
    }
  });
  return obj;
}

function serializeArgs(ref, data) {
  let s = ref[stream];
  let serialized = serialize(data, [], [], true);
  serialized.forEach(function(token) {
    switch(token[1]) {
      case 'function':
        let id = genId();
        s.local[id] = token[2];
        token[2]    = id;
        break;
    }
  });
  return serialized;
}

function deserializeArgs(ref, data) {
  let deserialized = deserialize(ref, data);
  return Object.keys(deserialized).map( key => deserialized[key] );
}

const rpc = module.exports = function (options, local, remote) {
  let opts = Object.assign({
    aggressive: true,
    base64    : false,
    burst     : true,
    mtu       : 2048,
    wait      :   10,
  }, options || {});

  // Ensure local & remote objects
  local  = local  || {};
  remote = remote || {};

  // Create the loop
  let input  = packetize.decode(opts);
  let output = packetize.encode(opts);
  let io = through(function (data) {
    input.write(data);
  }, function() {
    input.write(null);
  });
  output.pipe(nagle(opts))
    .on('data', function(chunk) {
      io.queue(chunk);
    })
    .on('end', function() {
      io.queue(null);
    });

  // Handle incoming data
  input.on('data', async function(data) {
    if (!data) return;
    data = mpack.decode(data);

    // Respond to state request
    if ('state' === data.fn) {
      io.output.write(mpack.encode({
        fn : 'update',
        arg: serialize(io.local)
      }));
      return;
    }

    // Handle incoming update
    if ('update' === data.fn) {
      deserialize(io, data.arg, io.remote);
      return;
    }

    // Handle a function call
    if (Array.isArray(data.fn)) {
      let target = io.local;
      for ( let key of data.fn ) {
        target = target[key] || {};
      }
      if ('function' !== typeof target) {
        return;
      }
      try {
        let result = await target(...deserializeArgs(io, data.arg));
        if (data.ret) {
          io.output.write(mpack.encode({
            fn : data.ret,
            arg: serializeArgs(io, [result]),
          }));
        }
      } catch(e) {
        if (data.err) {
          io.output.write(mpack.encode({
            fn : data.err,
            arg: serializeArgs(io, [serializeError(e)])
          }));
        }
      }
      return;
    }
  });

  // Attach references
  io.local   = local;
  io.remote  = remote;
  io.output  = output;
  io.input   = input;
  io[stream] = io;
  attachStream(io.remote,io);
  attachStream(io.local ,io);

  // Return the duplex
  return io;
};

rpc.remote = function (ref) {
  rpc.update(ref);
  return ref[stream].remote;
};

rpc.local = function(ref) {
  return ref[stream].local;
};

rpc.update = function(ref) {
  if (!ref[stream]) return;
  ref[stream].output.write(mpack.encode({fn: 'state'}));
};

rpc.updateRemote = function(ref) {
  if (!ref[stream]) return;
  attachStream(ref,ref[stream]);
  ref[stream].input.emit('data',mpack.encode({fn: 'state'}));
};
