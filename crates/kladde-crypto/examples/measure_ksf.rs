fn main() {
    let start = std::time::Instant::now();
    let output = kladde_crypto::backup_key(b"isolated-performance-probe", &[42; 16])
        .expect("Argon2id benchmark");
    std::hint::black_box(output.as_ref());
    println!("Argon2id 64 MiB t=3 p=1: {:?}", start.elapsed());
}
