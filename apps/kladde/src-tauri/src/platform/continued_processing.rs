use std::ffi::{CString, c_char};

unsafe extern "C" {
    fn kladde_continued_begin(name: *const c_char, title: *const c_char);

    fn kladde_continued_progress(name: *const c_char, done: i64, total: i64) -> bool;

    fn kladde_continued_end(name: *const c_char, success: bool);
}

pub struct ContinuedProcessing(Option<CString>);

impl ContinuedProcessing {
    pub fn begin(name: &str, title: &str) -> Self {
        let (Ok(name), Ok(title)) = (CString::new(name), CString::new(title)) else {
            return Self(None);
        };

        unsafe { kladde_continued_begin(name.as_ptr(), title.as_ptr()) };

        Self(Some(name))
    }

    pub fn progress(&self, done: u64, total: u64) -> bool {
        let Some(name) = &self.0 else {
            return true;
        };

        unsafe { kladde_continued_progress(name.as_ptr(), units(done), units(total)) }
    }

    pub fn finish(mut self, success: bool) {
        self.end(success);
    }

    fn end(&mut self, success: bool) {
        if let Some(name) = self.0.take() {
            unsafe { kladde_continued_end(name.as_ptr(), success) };
        }
    }
}

impl Drop for ContinuedProcessing {
    fn drop(&mut self) {
        self.end(false);
    }
}

fn units(bytes: u64) -> i64 {
    i64::try_from(bytes).unwrap_or(i64::MAX)
}
