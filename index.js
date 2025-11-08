const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const express = require('express');
const { ethers } = require('ethers');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = 5000;

const abiPath = path.join(__dirname, 'abi.json');
if (!fs.existsSync(abiPath)) {
  console.error('Missing abi.json. Please ensure the ABI file is present.');
  process.exit(1);
}

const erc20Abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function emitLog(session, level, message) {
  const payload = { level, message, timestamp: new Date().toISOString() };
  session.buffer.push(payload);
  session.emitter.emit('log', payload);
}

function extractRevertReason(error) {
  const data = error?.error?.data ?? error?.data;
  if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
    try {
      const reasonHex = '0x' + data.slice(10);
      const [reason] = ethers.utils.defaultAbiCoder.decode(['string'], reasonHex);
      return reason;
    } catch (decodeError) {
      return `Failed to decode revert reason: ${decodeError.message}`;
    }
  }
  if (typeof data === 'string') {
    return `Reverted with data: ${data}`;
  }
  return error?.message ?? 'Transaction failed with an unknown error.';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRevertReason(provider, tx, blockNumber) {
  try {
    await provider.call({
      to: tx.to,
      from: tx.from,
      data: tx.data,
      gasPrice: tx.gasPrice,
      gasLimit: tx.gasLimit,
      value: tx.value,
    }, blockNumber);
  } catch (error) {
    return extractRevertReason(error);
  }
  return null;
}

async function monitorTransaction(txResponse, provider, session) {
  const hash = txResponse.hash;
  let lastState = '';
  emitLog(session, 'info', `Monitoring transaction ${hash} ...`);

  while (true) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) {
      if (receipt.status === 1) {
        emitLog(session, 'success', `✅ Transaction confirmed in block ${receipt.blockNumber}.`);
      } else {
        emitLog(session, 'error', '❌ Transaction was mined but reverted.');
        const reason = await fetchRevertReason(provider, txResponse, receipt.blockNumber);
        if (reason) {
          emitLog(session, 'error', `Revert reason: ${reason}`);
        }
      }
      emitLog(session, 'info', `Gas used: ${receipt.gasUsed.toString()}`);
      emitLog(session, 'info', `View on Etherscan: https://etherscan.io/tx/${hash}`);
      return;
    }

    const tx = await provider.getTransaction(hash);
    if (!tx) {
      if (lastState !== 'notfound') {
        emitLog(
          session,
          'warn',
          'Transaction not yet found in mempool (it may still be propagating or was dropped).'
        );
        lastState = 'notfound';
      }
    } else if (tx.blockNumber == null) {
      if (lastState !== 'pending') {
        emitLog(session, 'info', '⏳ Transaction is still pending.');
        lastState = 'pending';
      }
    }

    await delay(POLL_INTERVAL_MS);
  }
}

function resolveConfig(body = {}) {
  return {
    rpcUrl: body.rpcUrl || process.env.RPC_URL,
    privateKey: body.privateKey || process.env.PRIVATE_KEY,
    tokenAddress: body.tokenAddress || process.env.TOKEN_ADDRESS,
    recipient: body.recipient || process.env.RECIPIENT,
    amount: body.amount || process.env.AMOUNT,
    gasPriceGwei: body.gasPriceGwei || process.env.GAS_PRICE_GWEI,
    gasLimit: body.gasLimit || process.env.GAS_LIMIT,
  };
}

function validateConfig(config) {
  const missing = [];
  if (!config.rpcUrl) missing.push('RPC_URL');
  if (!config.privateKey) missing.push('PRIVATE_KEY');
  if (!config.tokenAddress) missing.push('TOKEN_ADDRESS');
  if (!config.recipient) missing.push('RECIPIENT');
  if (!config.amount) missing.push('AMOUNT');
  return missing;
}

async function runTransfer(config, session) {
  const missing = validateConfig(config);
  if (missing.length > 0) {
    emitLog(session, 'error', `Missing required configuration: ${missing.join(', ')}`);
    return;
  }

  emitLog(session, 'info', 'Initializing provider and wallet...');
  let provider;
  try {
    provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  } catch (error) {
    emitLog(session, 'error', `Failed to connect to RPC: ${error.message}`);
    return;
  }

  let wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey, provider);
  } catch (error) {
    emitLog(session, 'error', `Invalid private key: ${error.message}`);
    return;
  }

  emitLog(session, 'info', `Using sender address: ${wallet.address}`);

  const token = new ethers.Contract(config.tokenAddress, erc20Abi, wallet);

  let symbol = 'token';
  try {
    symbol = await token.symbol();
  } catch (error) {
    emitLog(session, 'warn', 'Could not fetch token symbol; continuing.');
  }

  let decimals = 18;
  try {
    decimals = await token.decimals();
  } catch (error) {
    emitLog(session, 'warn', 'Could not fetch token decimals; defaulting to 18.');
  }

  let amount;
  try {
    amount = ethers.utils.parseUnits(config.amount.toString(), decimals);
  } catch (error) {
    emitLog(session, 'error', `Invalid amount: ${error.message}`);
    return;
  }

  const overrides = {};
  if (config.gasPriceGwei) {
    try {
      overrides.gasPrice = ethers.utils.parseUnits(config.gasPriceGwei.toString(), 'gwei');
    } catch (error) {
      emitLog(session, 'error', `Invalid gas price: ${error.message}`);
      return;
    }
  }

  if (config.gasLimit) {
    emitLog(
      session,
      'warn',
      'Ignoring provided gas limit — the dashboard intentionally underfunds gas to force a revert.'
    );
  }

  let forcedGasLimit;
  try {
    const estimatedGas = await token.estimateGas.transfer(config.recipient, amount, overrides);
    if (estimatedGas.gt(1)) {
      forcedGasLimit = estimatedGas.sub(1);
    } else {
      forcedGasLimit = ethers.BigNumber.from(1);
    }
    emitLog(
      session,
      'warn',
      `Intentionally setting gas limit to ${forcedGasLimit.toString()} (below estimated ${estimatedGas.toString()}) to guarantee failure.`
    );
  } catch (error) {
    forcedGasLimit = ethers.BigNumber.from(45000);
    emitLog(
      session,
      'warn',
      `Gas estimation failed (${error.message}). Falling back to minimal gas limit ${forcedGasLimit.toString()} to trigger failure.`
    );
  }

  overrides.gasLimit = forcedGasLimit;

  emitLog(
    session,
    'info',
    `Broadcasting ${config.amount} ${symbol} to ${config.recipient}...`
  );
  if (overrides.gasPrice) {
    emitLog(
      session,
      'info',
      `Custom gas price: ${ethers.utils.formatUnits(overrides.gasPrice, 'gwei')} gwei`
    );
  }
  emitLog(session, 'info', `Forced gas limit: ${overrides.gasLimit.toString()}`);

  let txResponse;
  try {
    txResponse = await token.transfer(config.recipient, amount, overrides);
  } catch (error) {
    emitLog(session, 'error', `Failed to send transaction: ${error.message}`);
    return;
  }

  emitLog(session, 'success', `Transaction submitted. Hash: ${txResponse.hash}`);
  emitLog(session, 'info', `Track on Etherscan: https://etherscan.io/tx/${txResponse.hash}`);

  try {
    await monitorTransaction(txResponse, provider, session);
  } catch (error) {
    emitLog(session, 'error', `Error while monitoring transaction: ${error.message}`);
  }
}

app.post('/api/send', (req, res) => {
  const sessionId = randomUUID();
  const session = { emitter: new EventEmitter(), buffer: [] };
  sessions.set(sessionId, session);
  res.json({ sessionId });

  runTransfer(resolveConfig(req.body), session)
    .catch((error) => {
      emitLog(session, 'error', `Unexpected error: ${error.message}`);
    })
    .finally(() => {
      session.emitter.emit('end');
      sessions.delete(sessionId);
    });
});

app.get('/api/events/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  if (!session) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Session not found.' })}\n\n`);
    res.write('event: end\ndata: {}\n\n');
    res.end();
    return;
  }

  session.buffer.forEach((payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  });

  const onLog = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const onEnd = () => {
    res.write('event: end\ndata: {}\n\n');
    res.end();
  };

  session.emitter.on('log', onLog);
  session.emitter.once('end', onEnd);

  req.on('close', () => {
    session.emitter.off('log', onLog);
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Open your browser to load the ERC20 transfer dashboard.');
});