#![allow(non_camel_case_types)]

use std::ffi::{CString, c_char, c_void};
use std::ptr;

type napi_env = *mut c_void;
type napi_value = *mut c_void;
type napi_callback_info = *mut c_void;
type napi_status = i32;
type napi_property_attributes = i32;
type napi_callback = unsafe extern "C" fn(napi_env, napi_callback_info) -> napi_value;

const NAPI_OK: napi_status = 0;
const NAPI_DEFAULT: napi_property_attributes = 0;

#[repr(C)]
struct napi_property_descriptor {
    utf8name: *const c_char,
    name: napi_value,
    method: Option<napi_callback>,
    getter: Option<napi_callback>,
    setter: Option<napi_callback>,
    value: napi_value,
    attributes: napi_property_attributes,
    data: *mut c_void,
}

unsafe extern "C" {
    fn napi_get_cb_info(
        env: napi_env,
        cbinfo: napi_callback_info,
        argc: *mut usize,
        argv: *mut napi_value,
        this_arg: *mut napi_value,
        data: *mut *mut c_void,
    ) -> napi_status;
    fn napi_get_value_string_utf8(
        env: napi_env,
        value: napi_value,
        buf: *mut c_char,
        bufsize: usize,
        result: *mut usize,
    ) -> napi_status;
    fn napi_create_string_utf8(
        env: napi_env,
        str_: *const c_char,
        length: usize,
        result: *mut napi_value,
    ) -> napi_status;
    fn napi_throw_type_error(env: napi_env, code: *const c_char, msg: *const c_char)
    -> napi_status;
    fn napi_define_properties(
        env: napi_env,
        object: napi_value,
        property_count: usize,
        properties: *const napi_property_descriptor,
    ) -> napi_status;
}

#[unsafe(no_mangle)]
/// Registers the Ferrite Node-API exports.
///
/// # Safety
///
/// Node.js must call this function with a valid `napi_env` and exports object
/// during native addon initialization. The pointers must remain valid for the
/// duration of the call.
pub unsafe extern "C" fn napi_register_module_v1(env: napi_env, exports: napi_value) -> napi_value {
    static RENDER_JSON_TO_HTML_NAME: &[u8] = b"renderJsonToHtml\0";
    let descriptor = napi_property_descriptor {
        utf8name: RENDER_JSON_TO_HTML_NAME.as_ptr().cast(),
        name: ptr::null_mut(),
        method: Some(render_json_to_html_callback),
        getter: None,
        setter: None,
        value: ptr::null_mut(),
        attributes: NAPI_DEFAULT,
        data: ptr::null_mut(),
    };

    let status = unsafe { napi_define_properties(env, exports, 1, &descriptor) };
    if status != NAPI_OK {
        unsafe { throw_type_error(env, "Ferrite native module failed to define exports.") };
    }

    exports
}

unsafe extern "C" fn render_json_to_html_callback(
    env: napi_env,
    info: napi_callback_info,
) -> napi_value {
    match unsafe { render_json_to_html_inner(env, info) } {
        Ok(value) => value,
        Err(message) => {
            unsafe { throw_type_error(env, &message) };
            ptr::null_mut()
        }
    }
}

unsafe fn render_json_to_html_inner(
    env: napi_env,
    info: napi_callback_info,
) -> Result<napi_value, String> {
    let mut argc = 1_usize;
    let mut argv = [ptr::null_mut(); 1];
    check_status(unsafe {
        napi_get_cb_info(
            env,
            info,
            &mut argc,
            argv.as_mut_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    })?;

    if argc != 1 || argv[0].is_null() {
        return Err("Ferrite renderJsonToHtml expects one string argument.".to_owned());
    }

    let input = unsafe { read_js_string(env, argv[0]) }?;
    let html = ferrite_ssr::render_json_to_html(&input).map_err(|error| error.to_string())?;
    unsafe { create_js_string(env, &html) }
}

unsafe fn read_js_string(env: napi_env, value: napi_value) -> Result<String, String> {
    let mut length = 0_usize;
    let status = unsafe { napi_get_value_string_utf8(env, value, ptr::null_mut(), 0, &mut length) };
    if status != NAPI_OK {
        return Err("Ferrite renderJsonToHtml expects one string argument.".to_owned());
    }

    let mut buffer = vec![0_u8; length + 1];
    let mut copied = 0_usize;
    check_status(unsafe {
        napi_get_value_string_utf8(
            env,
            value,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut copied,
        )
    })?;
    buffer.truncate(copied);
    String::from_utf8(buffer).map_err(|error| format!("Ferrite input must be valid UTF-8: {error}"))
}

unsafe fn create_js_string(env: napi_env, value: &str) -> Result<napi_value, String> {
    let mut output = ptr::null_mut();
    check_status(unsafe {
        napi_create_string_utf8(env, value.as_ptr().cast(), value.len(), &mut output)
    })?;
    Ok(output)
}

fn check_status(status: napi_status) -> Result<(), String> {
    if status == NAPI_OK {
        Ok(())
    } else {
        Err(format!("Node-API call failed with status {status}."))
    }
}

unsafe fn throw_type_error(env: napi_env, message: &str) {
    let sanitized = message.replace('\0', " ");
    let Ok(message) = CString::new(sanitized) else {
        return;
    };
    let _ = unsafe { napi_throw_type_error(env, ptr::null(), message.as_ptr()) };
}
