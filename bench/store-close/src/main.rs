//! Does closing Oxigraph (RocksDB) stores give their memory back?
//!
//! One run = one process = one configuration:
//!   open N stores -> write M ADAM-shaped links into each (one transaction per
//!   link, the way ADAM's `SparqlStore::write_link` does) -> optionally
//!   `Store::flush()` each -> drop (close) every store -> read RSS right
//!   after, after a settle delay, after `malloc_trim(0)`, and (jemalloc build)
//!   after an explicit arena purge -> reopen every store, timed -> close again.
//!
//! Output: one JSON object on stdout. Progress goes to stderr.
//!
//! Allocator is chosen at build time: default build = the system allocator
//! (glibc malloc); `--features jemalloc` = tikv-jemallocator built like the
//! ADAM executor's `cli` crate (unprefixed on Linux, same `_rjem_malloc_conf`
//! export). Set `MALLOC_CONF` at run time to override jemalloc options.

use oxigraph::model::{GraphNameRef, Literal, NamedNode, QuadRef, Term, TermRef, Triple};
use oxigraph::store::{Store, StoreOptions};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(feature = "jemalloc")]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

// Same export as ADAM's cli/src/ad4m_executor.rs. With the
// `unprefixed_malloc_on_supported_platforms` feature on Linux, jemalloc's
// symbols carry no `_rjem_` prefix, so whether jemalloc reads this symbol at
// all is something this bench reports (see `jemalloc_opts`).
#[cfg(feature = "jemalloc")]
#[allow(non_upper_case_globals)]
#[export_name = "_rjem_malloc_conf"]
pub static _rjem_malloc_conf: Option<&'static [u8]> =
    Some(b"background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000\0");

/// ADAM's SPARQL store open option (rust-executor/src/perspectives/sparql_store.rs).
const SPARQL_STORE_MAX_OPEN_FILES: u32 = 266;

const RDF_REIFIES: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies";
const ONT_AUTHOR: &str = "ad4m://ontology/author";
const ONT_TIMESTAMP: &str = "ad4m://ontology/timestamp";
const ONT_PROOF_KEY: &str = "ad4m://ontology/proofKey";
const ONT_PROOF_SIG: &str = "ad4m://ontology/proofSignature";
const ONT_PROOF_VALID: &str = "ad4m://ontology/proofValid";
const ONT_STATUS: &str = "ad4m://ontology/status";

struct Args {
    n: usize,
    m: usize,
    flush: bool,
    dir: PathBuf,
    threads: usize,
    settle_secs: u64,
    label: String,
}

fn parse_args() -> Args {
    let mut a = Args {
        n: 50,
        m: 1000,
        flush: false,
        dir: PathBuf::from("scratch"),
        threads: 8,
        settle_secs: 5,
        label: String::new(),
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < argv.len() {
        let key = argv[i].as_str();
        let val = || argv.get(i + 1).cloned().unwrap_or_else(|| panic!("{key} needs a value"));
        match key {
            "--n" => a.n = val().parse().expect("--n"),
            "--m" => a.m = val().parse().expect("--m"),
            "--flush" => a.flush = matches!(val().as_str(), "1" | "true" | "yes"),
            "--dir" => a.dir = PathBuf::from(val()),
            "--threads" => a.threads = val().parse().expect("--threads"),
            "--settle-secs" => a.settle_secs = val().parse().expect("--settle-secs"),
            "--label" => a.label = val(),
            other => panic!("unknown argument {other}"),
        }
        i += 2;
    }
    a
}

/// VmRSS, RssAnon, RssFile, VmHWM in KiB from /proc/self/status.
fn mem() -> serde_json::Value {
    let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| -> u64 {
        s.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    };
    let threads = field("Threads:");
    serde_json::json!({
        "rss_mib": field("VmRSS:") as f64 / 1024.0,
        "anon_mib": field("RssAnon:") as f64 / 1024.0,
        "file_mib": field("RssFile:") as f64 / 1024.0,
        "hwm_mib": field("VmHWM:") as f64 / 1024.0,
        "threads": threads,
        "alloc": allocator_stats(),
    })
}

#[cfg(feature = "jemalloc")]
fn allocator_stats() -> serde_json::Value {
    use tikv_jemalloc_ctl::{epoch, stats};
    let _ = epoch::advance();
    let mib = |v: Result<usize, _>| v.map(|b| b as f64 / 1048576.0).unwrap_or(-1.0);
    serde_json::json!({
        "kind": "jemalloc",
        "allocated_mib": mib(stats::allocated::read()),
        "active_mib": mib(stats::active::read()),
        "resident_mib": mib(stats::resident::read()),
        "retained_mib": mib(stats::retained::read()),
    })
}

#[cfg(not(feature = "jemalloc"))]
fn allocator_stats() -> serde_json::Value {
    // glibc: mallinfo2 reports arena bytes in use and free-but-held.
    let mi = unsafe { libc::mallinfo2() };
    serde_json::json!({
        "kind": "glibc",
        "in_use_mib": (mi.uordblks + mi.hblkhd) as f64 / 1048576.0,
        "free_held_mib": mi.fordblks as f64 / 1048576.0,
        "arena_mib": mi.arena as f64 / 1048576.0,
        "mmap_mib": mi.hblkhd as f64 / 1048576.0,
    })
}

/// The jemalloc options actually in effect, to tell whether the
/// `_rjem_malloc_conf` export (ADAM's tuning) was read at all.
#[cfg(feature = "jemalloc")]
fn jemalloc_opts() -> serde_json::Value {
    use tikv_jemalloc_ctl::raw;
    let b = |name: &[u8]| unsafe { raw::read::<bool>(name) }.ok();
    let i = |name: &[u8]| unsafe { raw::read::<isize>(name) }.ok();
    serde_json::json!({
        "opt.background_thread": b(b"opt.background_thread\0"),
        "background_thread": b(b"background_thread\0"),
        "opt.dirty_decay_ms": i(b"opt.dirty_decay_ms\0"),
        "opt.muzzy_decay_ms": i(b"opt.muzzy_decay_ms\0"),
        "MALLOC_CONF_env": std::env::var("MALLOC_CONF").ok(),
    })
}

#[cfg(not(feature = "jemalloc"))]
fn jemalloc_opts() -> serde_json::Value {
    serde_json::Value::Null
}

/// jemalloc's own "give it back now": purge every arena. No-op for glibc.
#[cfg(feature = "jemalloc")]
fn allocator_purge() -> bool {
    // MALLCTL_ARENAS_ALL = 4096
    let name = b"arena.4096.purge\0";
    let rc = unsafe {
        tikv_jemalloc_sys::mallctl(
            name.as_ptr() as *const libc::c_char,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    rc == 0
}

#[cfg(not(feature = "jemalloc"))]
fn allocator_purge() -> bool {
    false
}

fn open_store(path: &Path) -> Store {
    std::fs::create_dir_all(path).expect("create store dir");
    Store::open_with_options(
        path,
        StoreOptions::default().with_max_open_files(SPARQL_STORE_MAX_OPEN_FILES),
    )
    .expect("open store")
}

/// Pseudo-random but deterministic hex of `len` chars.
fn hexish(seed: &str, len: usize) -> String {
    let mut out = String::new();
    let mut h = Sha256::digest(seed.as_bytes()).to_vec();
    while out.len() < len {
        out.push_str(&hex::encode(&h));
        h = Sha256::digest(&h).to_vec();
    }
    out.truncate(len);
    out
}

/// Write one WE-shaped link the way ADAM stores it: the direct triple, the
/// reifier `<link:HASH> rdf:reifies <<( s p o )>>`, and the reifier's
/// annotations (author, timestamp, status, proof key/signature/valid), all in
/// one transaction. Even links are channel -> message (IRI target); odd links
/// are message -> body (a ~120-char literal, as `literal://string:` targets
/// are stored).
fn write_link(store: &Store, store_idx: usize, i: usize, authors: &[String]) {
    let author = &authors[i % authors.len()];
    let ts = format!(
        "2026-11-13T{:02}:{:02}:{:02}.{:03}Z",
        (i / 3_600_000) % 24,
        (i / 60_000) % 60,
        (i / 1000) % 60,
        i % 1000
    );
    let msg = format!("expr://we-message/{store_idx}/{}", i / 2);
    let (source, predicate, target): (NamedNode, NamedNode, Term) = if i % 2 == 0 {
        (
            NamedNode::new_unchecked(format!("ad4m://channel/{store_idx}")),
            NamedNode::new_unchecked("ad4m://has_child"),
            NamedNode::new_unchecked(msg).into(),
        )
    } else {
        (
            NamedNode::new_unchecked(msg),
            NamedNode::new_unchecked("flux://body"),
            Literal::new_simple_literal(format!(
                "transcript line {i} from {}: {}",
                &author[..20],
                hexish(&format!("{store_idx}/{i}"), 80)
            ))
            .into(),
        )
    };
    let mut hasher = Sha256::new();
    hasher.update(author.as_bytes());
    hasher.update(source.as_str().as_bytes());
    hasher.update(predicate.as_str().as_bytes());
    hasher.update(target.to_string().as_bytes());
    hasher.update(ts.as_bytes());
    let reifier = NamedNode::new_unchecked(format!("link:{}", &hex::encode(hasher.finalize())[..32]));
    let triple = Triple::new(source.clone(), predicate.clone(), target.clone());
    let sig = hexish(&format!("sig/{store_idx}/{i}"), 128);
    let key = format!("{author}#{}", &author[8..]);
    let annotations: [(&str, &str); 6] = [
        (ONT_AUTHOR, author.as_str()),
        (ONT_TIMESTAMP, ts.as_str()),
        (ONT_STATUS, "shared"),
        (ONT_PROOF_KEY, key.as_str()),
        (ONT_PROOF_SIG, sig.as_str()),
        (ONT_PROOF_VALID, "true"),
    ];

    let mut tx = store.start_transaction().expect("tx");
    let target_ref: TermRef = match &target {
        Term::NamedNode(n) => n.as_ref().into(),
        Term::Literal(l) => l.as_ref().into(),
        _ => unreachable!(),
    };
    tx.insert(QuadRef::new(&source, &predicate, target_ref, GraphNameRef::DefaultGraph));
    let reifies = NamedNode::new_unchecked(RDF_REIFIES);
    tx.insert(QuadRef::new(
        &reifier,
        &reifies,
        TermRef::Triple(&triple),
        GraphNameRef::DefaultGraph,
    ));
    for (p, v) in annotations {
        let p = NamedNode::new_unchecked(p);
        let v = Literal::new_simple_literal(v);
        tx.insert(QuadRef::new(&reifier, &p, &v, GraphNameRef::DefaultGraph));
    }
    tx.commit().expect("commit");
}

fn store_path(base: &Path, idx: usize) -> PathBuf {
    base.join(format!("space-{idx:04}")).join("sparql_store")
}

/// Run `f(idx)` for idx in 0..n on `threads` threads; returns results in order.
fn par_map<T: Send>(n: usize, threads: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let threads = threads.max(1).min(n.max(1));
    let mut slots: Vec<Option<T>> = (0..n).map(|_| None).collect();
    let chunk = n.div_ceil(threads).max(1);
    std::thread::scope(|s| {
        for (c, part) in slots.chunks_mut(chunk).enumerate() {
            let f = &f;
            s.spawn(move || {
                for (j, slot) in part.iter_mut().enumerate() {
                    *slot = Some(f(c * chunk + j));
                }
            });
        }
    });
    slots.into_iter().map(|o| o.expect("slot")).collect()
}

fn secs(d: Duration) -> f64 {
    (d.as_secs_f64() * 1000.0).round() / 1000.0
}

fn main() {
    let a = parse_args();
    let run_dir = a.dir.join(format!(
        "run-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    std::fs::create_dir_all(&run_dir).expect("create run dir");
    let authors: Vec<String> = (0..6)
        .map(|k| format!("did:key:z6Mk{}", hexish(&format!("author{k}"), 44)))
        .collect();
    let mut samples = serde_json::Map::new();
    let mut times = serde_json::Map::new();
    let mut snap = |name: &str, s: &mut serde_json::Map<String, serde_json::Value>| {
        eprintln!("[{}] {name}", a.label);
        s.insert(name.to_string(), mem());
    };

    snap("start", &mut samples);

    let t = Instant::now();
    let stores: Vec<Store> = par_map(a.n, a.threads, |i| open_store(&store_path(&run_dir, i)));
    times.insert("open_s".into(), secs(t.elapsed()).into());
    snap("opened", &mut samples);

    let t = Instant::now();
    par_map(a.n, a.threads, |s| {
        for i in 0..a.m {
            write_link(&stores[s], s, i, &authors);
        }
    });
    times.insert("write_s".into(), secs(t.elapsed()).into());
    snap("written", &mut samples);

    let quads: usize = stores.iter().map(|s| s.len().unwrap_or(0)).sum();

    if a.flush {
        let t = Instant::now();
        par_map(a.n, a.threads, |s| stores[s].flush().expect("flush"));
        times.insert("flush_s".into(), secs(t.elapsed()).into());
        snap("flushed", &mut samples);
    }

    let t = Instant::now();
    drop(stores);
    times.insert("close_s".into(), secs(t.elapsed()).into());
    snap("closed", &mut samples);
    std::thread::sleep(Duration::from_secs(a.settle_secs));
    snap("closed_settled", &mut samples);
    let trim_rc = unsafe { libc::malloc_trim(0) };
    snap("closed_trimmed", &mut samples);
    let purged = allocator_purge();
    if purged {
        snap("closed_purged", &mut samples);
    }

    let t = Instant::now();
    let stores: Vec<Store> = par_map(a.n, a.threads, |i| open_store(&store_path(&run_dir, i)));
    times.insert("reopen_s".into(), secs(t.elapsed()).into());
    snap("reopened", &mut samples);
    let t = Instant::now();
    let quads_after: usize = stores.iter().map(|s| s.len().unwrap_or(0)).sum();
    times.insert("reopen_count_s".into(), secs(t.elapsed()).into());
    snap("reopened_counted", &mut samples);
    drop(stores);
    std::thread::sleep(Duration::from_secs(a.settle_secs));
    unsafe { libc::malloc_trim(0) };
    allocator_purge();
    snap("reclosed_trimmed", &mut samples);

    let disk = dir_size(&run_dir);
    let out = serde_json::json!({
        "label": a.label,
        "allocator": if cfg!(feature = "jemalloc") { "jemalloc" } else { "glibc" },
        "jemalloc_opts": jemalloc_opts(),
        "n": a.n,
        "m": a.m,
        "flush": a.flush,
        "threads": a.threads,
        "settle_secs": a.settle_secs,
        "quads": quads,
        "quads_after_reopen": quads_after,
        "disk_mib": disk.0 as f64 / 1048576.0,
        "wal_mib": disk.1 as f64 / 1048576.0,
        "malloc_trim_released": trim_rc == 1,
        "times": times,
        "samples": samples,
        "store_dir": run_dir,
    });
    println!("{out}");
}

/// (all bytes, bytes in RocksDB write-ahead logs `*.log`) under `dir`.
fn dir_size(dir: &Path) -> (u64, u64) {
    let mut total = 0;
    let mut wal = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(md) = e.metadata() {
                if md.is_dir() {
                    let (t, w) = dir_size(&p);
                    total += t;
                    wal += w;
                } else {
                    total += md.len();
                    if p.extension().is_some_and(|x| x == "log")
                        && p.file_name().is_some_and(|n| n.to_string_lossy().chars().next().is_some_and(|c| c.is_ascii_digit()))
                    {
                        wal += md.len();
                    }
                }
            }
        }
    }
    (total, wal)
}
