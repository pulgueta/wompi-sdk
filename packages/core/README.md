# @pulgueta/wompi

This is the **unofficial** Wompi SDK. This package features a simpler abstraction for the Wompi API, making it easier to interact as a developer and to integrate into your projects.

## Installation

To install this package, you can use NPM, Yarn, or PNPM:

```bash
npm install @pulgueta/wompi
```

```bash
yarn add @pulgueta/wompi
```

```bash
pnpm add @pulgueta/wompi
```

## Usage

Let's break down the usage into a few steps:

### Client

First, you need to create a client with your public keys:

```typescript
import { WompiClient } from '@pulgueta/wompi/client';

const wompi = new WompiClient({
  publicKey: 'your-public-key',
  publicEventsKey: 'your-public-events-key',
  eventsUrl: 'https://events.yourdomain.com',
});

// src/utils/index.ts
export const getLatestTransactions = async () => {
  const transactions = await wompi.transactions.getTransactions();

  return transactions;
};
```
