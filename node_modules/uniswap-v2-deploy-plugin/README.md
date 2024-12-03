# uniswap-v2-deploy-plugin

Deploy the Uniswap V2 contracts in your hardhat development environment.

Despite Uniswap V3 being released, many projects across many different EVM compatible blockchains are still using the old V2 contracts. Developing against Uniswap V2, Sushiswap, Ubeswap, Pangolin, XxxSwap, etc has previously been painful, but no longer.

## Installation

```sh
$ yarn add uniswap-v2-deploy-plugin
```

Import the plugin in your `hardhat.config.js`:

```js
require("uniswap-v2-deploy-plugin");
```

Or if you are using TypeScript, in your `hardhat.config.ts`:

```ts
import "uniswap-v2-deploy-plugin";
```

Great! Now to deploy the contracts in your tests, checkout the [swap.ts](test/swap.ts) file to see how you'd use this plugin to ease your development process.
