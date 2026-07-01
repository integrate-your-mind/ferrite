fn main() {
    if let Err(error) = ferrite_cli::run() {
        eprintln!("error: {error}");
        std::process::exit(error.exit_code());
    }
}
