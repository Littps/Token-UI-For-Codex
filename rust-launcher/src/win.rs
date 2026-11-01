use std::ffi::OsString;
use std::mem::size_of;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use anyhow::{Context, Result};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, STILL_ACTIVE,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::Win32::System::Threading::{
    CreateMutexW, GetExitCodeProcess, OpenProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, QueryFullProcessImageNameW,
    TerminateProcess,
};
use windows::core::PCWSTR;

pub struct NamedMutex {
    handle: HANDLE,
}

impl NamedMutex {
    pub fn acquire(name: &str) -> Result<Option<Self>> {
        let wide = wide(name);
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(wide.as_ptr())) }
            .context("CreateMutexW failed")?;
        let already_exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if already_exists {
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Ok(None);
        }
        Ok(Some(Self { handle }))
    }
}

impl Drop for NamedMutex {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

pub struct JobHandle {
    handle: HANDLE,
}

impl JobHandle {
    pub fn create() -> Result<Self> {
        let handle =
            unsafe { CreateJobObjectW(None, PCWSTR::null()) }.context("CreateJobObjectW failed")?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .context("SetInformationJobObject failed")?;
        Ok(Self { handle })
    }

    pub fn assign(&self, process: HANDLE) -> Result<()> {
        unsafe { AssignProcessToJobObject(self.handle, process) }
            .context("AssignProcessToJobObject failed")
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

pub fn process_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => {
            let mut exit_code = 0_u32;
            let exit_code_ok = unsafe { GetExitCodeProcess(handle, &mut exit_code) }.is_ok();
            unsafe {
                let _ = CloseHandle(handle);
            }
            exit_code_ok && exit_code == STILL_ACTIVE.0 as u32
        }
        Err(_) => false,
    }
}

pub fn process_image_path(pid: u32) -> Option<PathBuf> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.ok()?;
    buffer.truncate(length as usize);
    Some(PathBuf::from(OsString::from_wide(&buffer)))
}

pub fn terminate_process(pid: u32) -> Result<()> {
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }
        .with_context(|| format!("OpenProcess({pid}) failed"))?;
    let result = unsafe { TerminateProcess(handle, 1) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.with_context(|| format!("TerminateProcess({pid}) failed"))
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
