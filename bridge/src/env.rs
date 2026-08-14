//! Environment-variable parsing shared by the bridge's opt-in checks.
//!
//! Treating any non-empty value as "on" makes `CONDUIT_ENABLE=0` mean enabled,
//! which is the opposite of what anyone writing it intends. The broker applies
//! the same rule (`broker/src/env.ts`), and both ends must agree: they derive
//! the same endpoint from `CONDUIT_TCP`, so disagreeing on what it means would
//! leave them looking for each other on different transports.

const OFF_VALUES: [&str; 5] = ["", "0", "false", "no", "off"];

/// Whether a boolean environment variable is set to something meaning on.
pub fn env_flag(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            !OFF_VALUES.contains(&normalized.as_str())
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::env_flag;

    // Serialised through one test: the process environment is global, and the
    // other suites read these same variables.
    #[test]
    fn off_values_are_off_and_everything_else_is_on() {
        let name = "CONDUIT_TEST_ENV_FLAG";
        unsafe { std::env::remove_var(name) };
        assert!(!env_flag(name));

        for value in ["", "0", "false", "FALSE", "no", "off", " 0 "] {
            unsafe { std::env::set_var(name, value) };
            assert!(!env_flag(name), "expected {value:?} to be off");
        }
        for value in ["1", "true", "yes", "enabled"] {
            unsafe { std::env::set_var(name, value) };
            assert!(env_flag(name), "expected {value:?} to be on");
        }
        unsafe { std::env::remove_var(name) };
    }
}
