use alloy::{
    primitives::B256,
    providers::{Provider, ProviderBuilder, WsConnect},
    rpc::types::TransactionReceipt,
};

use anyhow::Result;
use clap::Parser;
use futures_util::StreamExt;

use std::env;
use std::fs;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::time::Instant;

use attestcoin_abi_encoding::abi::abi_encode;
use attestcoin_abi_encoding::common::EncodingVersion;

#[derive(Parser, Debug)]
#[command(name = "encode-blocks")]
pub struct CliArguments {
    #[arg(long, help = "WebSockets URL to an Ethereum RPC", required = true)]
    pub eth_rpc_url: String,

    #[arg(long, help = "Directory path to store JSON files", required = true)]
    pub path_to_store_json: String,
}

/// Spaces out RPC requests to stay under a provider's per-second request limit.
/// Without it, every transaction in a block is fetched at once, which can burst
/// past the limit of plans like QuickNode's.
///
/// Callers get evenly spaced slots in the order they ask, so the provider never
/// sees more than the configured number of requests in any second. Configured by
/// the `RPC_MAX_REQUESTS_PER_SECOND` env var; unset or 0 disables limiting.
#[derive(Clone)]
struct RateLimiter {
    max_per_second: f64,
    interval: Option<Duration>,
    next_slot: Arc<Mutex<Instant>>,
}

impl RateLimiter {
    fn from_env() -> Result<Self> {
        let max_per_second: f64 = match env::var("RPC_MAX_REQUESTS_PER_SECOND") {
            Ok(raw) if !raw.is_empty() => raw.parse().map_err(|_| {
                anyhow::anyhow!("RPC_MAX_REQUESTS_PER_SECOND must be a number, got '{raw}'")
            })?,
            _ => 0.0,
        };
        anyhow::ensure!(
            max_per_second.is_finite() && max_per_second >= 0.0,
            "RPC_MAX_REQUESTS_PER_SECOND must be a non-negative number, got {max_per_second}"
        );

        Ok(Self {
            max_per_second,
            interval: (max_per_second > 0.0).then(|| Duration::from_secs_f64(1.0 / max_per_second)),
            next_slot: Arc::new(Mutex::new(Instant::now())),
        })
    }

    fn describe(&self) -> String {
        if self.interval.is_some() {
            format!("{} req/s", self.max_per_second)
        } else {
            "none".into()
        }
    }

    /// Waits until the caller may send its next RPC request.
    async fn wait(&self) {
        let Some(interval) = self.interval else {
            return;
        };
        let slot = {
            let mut next_slot = self.next_slot.lock().unwrap();
            let slot = (*next_slot).max(Instant::now());
            *next_slot = slot + interval;
            slot
        };
        tokio::time::sleep_until(slot).await;
    }
}

async fn encode_transaction(
    provider: impl Provider,
    limiter: &RateLimiter,
    tx_hash_str: &str,
    rx_or_none: Option<TransactionReceipt>,
) -> Option<String> {
    let tx_hash = B256::from_str(tx_hash_str).unwrap();

    limiter.wait().await;
    let tx = match provider.get_transaction_by_hash(tx_hash).await {
        Ok(Some(tx)) => tx,
        Ok(None) => {
            println!("    skipping tx {tx_hash_str}: transaction not found via RPC");
            return None;
        }
        Err(e) => {
            println!("    skipping tx {tx_hash_str}: get_transaction_by_hash failed: {e}");
            return None;
        }
    };

    let rx = match rx_or_none {
        Some(rx) => rx,
        None => {
            limiter.wait().await;
            match provider.get_transaction_receipt(tx_hash).await {
                Ok(Some(rx)) => rx,
                Ok(None) => {
                    println!("    skipping tx {tx_hash_str}: receipt not found via RPC");
                    return None;
                }
                Err(e) => {
                    println!("    skipping tx {tx_hash_str}: get_transaction_receipt failed: {e}");
                    return None;
                }
            }
        }
    };

    let encoded_data = abi_encode(tx, rx, EncodingVersion::V1).unwrap();
    let as_str = hex::encode(encoded_data.abi());

    Some(format!("0x{as_str}"))
}

async fn encode_and_write_to_disk(
    path: String,
    provider: impl Provider,
    limiter: RateLimiter,
    block_number: u64,
    tx_hash: String,
    rx_or_none: Option<TransactionReceipt>,
) {
    let Some(encoded_data) =
        encode_transaction(provider, &limiter, &tx_hash.to_string(), rx_or_none).await
    else {
        // RPC returned None for this transaction (e.g. transient reorg or
        // unindexed tx); skip it rather than writing anything to disk.
        return;
    };

    // <path>/<block_num>/<tx_hash>.txt
    fs::write(
        format!("{path}/{block_number}/{tx_hash}.txt"),
        encoded_data + "\n",
    )
    .unwrap();
}

async fn block_handler(
    provider: impl Provider + Clone + 'static,
    limiter: RateLimiter,
    block_number: u64,
    path_to_store_json: String,
) -> Result<()> {
    println!("new block --- {block_number:?}");

    fs::create_dir_all(format!("{path_to_store_json}/{block_number}"))?;

    // Retry the block fetch up to 5 times with a 1s delay; the node may not
    // have the block indexed yet at the moment we get notified.
    const MAX_ATTEMPTS: u32 = 5;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(1);
    let mut block = None;
    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        limiter.wait().await;
        match provider
            .get_block_by_number(block_number.into())
            .full()
            .await
        {
            Ok(Some(b)) => {
                block = Some(b);
                break;
            }
            Ok(None) => {
                last_err = Some(anyhow::anyhow!(
                    "block {block_number} not found (attempt {attempt}/{MAX_ATTEMPTS})"
                ));
            }
            Err(e) => {
                last_err = Some(anyhow::anyhow!(
                    "failed to fetch block {block_number} (attempt {attempt}/{MAX_ATTEMPTS}): {e}"
                ));
            }
        }
        if attempt < MAX_ATTEMPTS {
            println!("    retrying block --- {block_number} (attempt {attempt}/{MAX_ATTEMPTS})");
            tokio::time::sleep(RETRY_DELAY).await;
        }
    }
    let block = block.ok_or_else(|| {
        last_err.unwrap_or_else(|| anyhow::anyhow!("failed to fetch block {block_number}"))
    })?;

    let tx_hashes = block.transactions.hashes();

    if tx_hashes.len() >= 13 {
        // optimize RPC cost by fetching all receipts at once
        limiter.wait().await;
        let receipts = provider
            .get_block_receipts(block_number.into())
            .await?
            .unwrap();
        let tasks: Vec<_> = receipts
            .into_iter()
            .map(|rcp| {
                tokio::spawn({
                    let prv = provider.clone();
                    let lim = limiter.clone();
                    let path = path_to_store_json.clone();
                    async move {
                        encode_and_write_to_disk(
                            path.clone(),
                            prv.clone(),
                            lim,
                            block_number,
                            rcp.transaction_hash.to_string(),
                            Some(rcp),
                        )
                        .await;
                    }
                })
            })
            .collect();

        for task in tasks {
            task.await.unwrap();
        }
    } else {
        // loop over each transaction and fetch its receipt via explicit RPC call
        let tasks: Vec<_> = tx_hashes
            .clone()
            .map(|tx_hash| {
                tokio::spawn({
                    let prv = provider.clone();
                    let lim = limiter.clone();
                    let path = path_to_store_json.clone();
                    async move {
                        encode_and_write_to_disk(
                            path.clone(),
                            prv.clone(),
                            lim,
                            block_number,
                            tx_hash.to_string(),
                            None,
                        )
                        .await;
                    }
                })
            })
            .collect();

        for task in tasks {
            task.await.unwrap();
        }
    }

    println!(
        "<<< done encoding {:?} transactions in block {:?}",
        tx_hashes.len(),
        block_number
    );

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = CliArguments::parse();

    let start = SystemTime::now();
    let timeout_minutes: u64 = env::var("TIMEOUT_MINUTES").unwrap_or("2".into()).parse()?;
    let limiter = RateLimiter::from_env()?;
    println!("=== starting with timeout {timeout_minutes:?} mins ...");
    println!("=== RPC rate limit: {}", limiter.describe());

    fs::create_dir_all(args.path_to_store_json.clone())?;

    let provider = ProviderBuilder::new()
        .connect_ws(WsConnect::new(args.eth_rpc_url))
        .await?;

    let subscriber = provider.subscribe_blocks().await?;
    let mut stream = subscriber.into_stream();
    let mut last_seen_block: Option<u64> = None;
    'outer: while let Some(block) = stream.next().await {
        if last_seen_block == Some(block.number) {
            println!(
                "    skipping duplicate notification for block --- {:?}",
                block.number
            );
            continue;
        }

        // Raw `newHeads` subscriptions only notify us of the latest head and do
        // not backfill blocks that were mined while we were busy encoding the
        // previous one. Walk the gap from the last block we processed up to the
        // current head so every intermediate block is encoded, giving a near
        // 1:1 mapping with the ethers encoder (which backfills the same way).
        let from = last_seen_block.map_or(block.number, |last| last + 1);
        for block_number in from..=block.number {
            let _ = block_handler(
                provider.clone(),
                limiter.clone(),
                block_number,
                args.path_to_store_json.clone(),
            )
            .await;

            last_seen_block = Some(block_number);

            let current = start.elapsed()?;
            if current.as_secs() >= timeout_minutes * 60 {
                println!("=== {timeout_minutes:?} mins timeout reached. exiting ...");
                break 'outer;
            }
        }
    }

    Ok(())
}
