# rpc-duplex

> Streamed RPC library for both Node.JS and the browser

## Install

```bash
npm install --save rpc-duplex
```

## Usage

### Node.JS

```js
const rpc = require('rpc-duplex');

// Creating a provider
const provider = rpc({
  capitalize( str ) {
    return str.toUpperCase();
  },
  throwError( arg ) {
    throw new Error(arg);
  }
});

// Creating a consumer
const consumer = rpc();

// Connect consumer & provider
// Normally this goes through a network of sorts
provider.pipe(consumer).pipe(provider);

// Use provided functions
const remote = rpc.from(consumer);

// Go async so you can copy-paste this code
(async () => {
  
  // Over a network, wait for the functions to appear
  while(!remote.capitalize) {
    await new Promise(resolve => {
      setTimeout(resolve,10);
    });
  }
  
  // Call a remote function
  let result = await remote.capitalize('foobar');
  console.log(result); // FOOBAR
  
  // Errors are re-thrown
  try {
    await remote.throwError('hello world');    
  } catch(e) {
    console.log(e.message); // hello world
  }
  
})();
```

### Browser

This package makes use of ES6 features. If you want to use this module in older browsers you'll need to use packages
like [esmify][esmify] to ensure it works.

[esmify]: https://npmjs.com/package/esmify
