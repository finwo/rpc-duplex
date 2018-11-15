import expect from 'expect';
import rpc    from './rpc';

// Build server
let server = rpc({
  user: {
    name: 'root',
    pass: 'toor'
  },
  fnReturn: function(arg) {
    return arg.toUpperCase();
  },
  fnCallback: function(arg, cb) {
    cb(null,arg.toUpperCase());
  },
  fnThrow: function() {
    throw new Error('foobar err');
  },
});

// Init client
let client = rpc();

// Connect them (normally through net)
server.pipe(client).pipe(server);

// Initialize the actual client
let remote = rpc.from(client);

test('Verify string values', () => {
  expect(remote.user.name).toBe('root');
  expect(remote.user.pass).toBe('toor');
});

test('Returning function', async () => {
  let result = await remote.fnReturn('foobar');
  expect(result).toBe('FOOBAR');
});

test('Callback function', async () => {
  let result = await new Promise((resolve,reject) => {
    remote.fnCallback('hello world', function(err, data) {
      if (err) return reject(err);
      resolve(data);
    });
  });
  expect(result).toBe('HELLO WORLD');
});

test('Throwing function', async () => {
  let thrown = false;
  try {
    await remote.fnThrow();
  } catch(e) {
    thrown = e;
  }
  expect(thrown).toBeTruthy();
  expect(thrown.message).toBe('foobar err');
});
