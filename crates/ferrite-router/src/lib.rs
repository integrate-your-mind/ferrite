mod legacy;

pub use legacy::{
    GENERATED_ROUTE_TYPES_HEADER, Result, Route, RouteParam, RouteParamKind, RouterError,
    find_document_file, generate_route_types,
};

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;

pub fn scan_app_dir(app_dir: impl AsRef<Path>) -> Result<Vec<Route>> {
    let routes = legacy::scan_app_dir(app_dir)?;
    validate_route_table(&routes)?;
    Ok(routes)
}

pub fn write_route_types(routes: &[Route], output_path: impl AsRef<Path>) -> Result<()> {
    write_route_types_with(
        routes,
        output_path.as_ref(),
        |file, contents| {
            file.write_all(contents)?;
            file.flush()?;
            file.sync_all()
        },
        |_| Ok(()),
        |_| Ok(()),
    )
}

fn write_route_types_with<WriteStaged, BeforeValidate, BeforePersist>(
    routes: &[Route],
    output_path: &Path,
    write_staged: WriteStaged,
    before_validate: BeforeValidate,
    before_persist: BeforePersist,
) -> Result<()>
where
    WriteStaged: FnOnce(&mut fs::File, &[u8]) -> io::Result<()>,
    BeforeValidate: FnOnce(&Path) -> io::Result<()>,
    BeforePersist: FnOnce(&Path) -> io::Result<()>,
{
    validate_route_table(routes)?;
    let initial_state = validate_route_types_output_state(output_path)?;
    verify_route_types_output_writable(&initial_state, output_path)?;
    let parent = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let contents = generate_route_types(routes);
    let mut staged = new_route_types_tempfile(parent)?;
    if let Some(permissions) = initial_state.permissions() {
        staged.as_file().set_permissions(permissions.clone())?;
    }
    write_staged(staged.as_file_mut(), contents.as_bytes())?;
    before_validate(output_path)?;

    let current_state = validate_route_types_output_state(output_path)?;
    verify_route_types_output_writable(&current_state, output_path)?;
    if !initial_state.same_output_state(&current_state) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "route types output `{}` changed while its replacement was staged",
                output_path.display()
            ),
        )
        .into());
    }
    before_persist(output_path)?;

    match initial_state {
        RouteTypesOutputState::Missing => {
            staged
                .persist_noclobber(output_path)
                .map_err(|error| error.error)?;
        }
        RouteTypesOutputState::Generated(_) => {
            staged.persist(output_path).map_err(|error| error.error)?;
        }
    }
    Ok(())
}

fn new_route_types_tempfile(parent: &Path) -> io::Result<tempfile::NamedTempFile> {
    #[cfg(unix)]
    let mut builder = tempfile::Builder::new();
    #[cfg(not(unix))]
    let builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    builder.tempfile_in(parent)
}

pub fn validate_route_types_output(output_path: impl AsRef<Path>) -> Result<()> {
    validate_route_types_output_state(output_path.as_ref()).map(|_| ())
}

#[derive(Debug)]
enum RouteTypesOutputState {
    Missing,
    Generated(fs::Permissions),
}

impl RouteTypesOutputState {
    fn permissions(&self) -> Option<&fs::Permissions> {
        match self {
            Self::Missing => None,
            Self::Generated(permissions) => Some(permissions),
        }
    }

    fn same_output_state(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Missing, Self::Missing) => true,
            (Self::Generated(left), Self::Generated(right)) => {
                route_type_permissions_match(left, right)
            }
            _ => false,
        }
    }
}

fn verify_route_types_output_writable(
    state: &RouteTypesOutputState,
    output_path: &Path,
) -> Result<()> {
    if matches!(state, RouteTypesOutputState::Generated(_)) {
        fs::OpenOptions::new().write(true).open(output_path)?;
    }
    Ok(())
}

fn route_type_permissions_match(left: &fs::Permissions, right: &fs::Permissions) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        left.mode() == right.mode()
    }
    #[cfg(not(unix))]
    {
        left.readonly() == right.readonly()
    }
}

fn validate_route_types_output_state(output_path: &Path) -> Result<RouteTypesOutputState> {
    let metadata = match fs::symlink_metadata(output_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RouteTypesOutputState::Missing);
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "refusing to replace non-generated route types output `{}`",
                output_path.display()
            ),
        )
        .into());
    }

    let mut prefix = vec![0; GENERATED_ROUTE_TYPES_HEADER.len()];
    let bytes_read = fs::File::open(output_path)?.read(&mut prefix)?;
    if bytes_read != prefix.len() || prefix != GENERATED_ROUTE_TYPES_HEADER.as_bytes() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "refusing to replace non-generated route types output `{}`",
                output_path.display()
            ),
        )
        .into());
    }
    Ok(RouteTypesOutputState::Generated(metadata.permissions()))
}

pub fn validate_route_table(routes: &[Route]) -> Result<()> {
    let mut canonical_paths = BTreeMap::<&str, &Path>::new();
    let mut validated_routes = Vec::<&Route>::with_capacity(routes.len());

    for route in routes {
        validate_route(route)?;
        if let Some(first) = canonical_paths.insert(&route.path, &route.file) {
            return Err(invalid_route(format!(
                "duplicate canonical path `{}` from `{}` and `{}`",
                route.path,
                first.display(),
                route.file.display()
            )));
        }

        for first in &validated_routes {
            if route_patterns_overlap(&first.path, &route.path) {
                return Err(invalid_route(format!(
                    "ambiguous route patterns `{}` in `{}` and `{}` in `{}`",
                    first.path,
                    first.file.display(),
                    route.path,
                    route.file.display()
                )));
            }
        }
        validated_routes.push(route);
    }
    Ok(())
}

fn validate_route(route: &Route) -> Result<()> {
    if route.path == "/" {
        if route.params.is_empty() {
            return Ok(());
        }
        return Err(invalid_route(
            "route `/` parameter metadata does not match its path".to_owned(),
        ));
    }

    if !route.path.starts_with('/')
        || route.path.ends_with('/')
        || route.path.contains("//")
        || route.path.contains('\\')
    {
        return Err(invalid_route(format!(
            "route path `{}` is not a normalized absolute path",
            route.path
        )));
    }

    let mut names = BTreeSet::new();
    for param in &route.params {
        if !is_valid_param_name(&param.name) {
            return Err(invalid_route(format!(
                "route `{}` contains invalid parameter `{}`",
                route.path, param.name
            )));
        }
        if !names.insert(param.name.as_str()) {
            return Err(invalid_route(format!(
                "route `{}` repeats parameter `{}`",
                route.path, param.name
            )));
        }
    }

    let segments = route
        .path
        .trim_start_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    let mut param_index = 0;
    for (index, segment) in segments.iter().enumerate() {
        let expected = route.params.get(param_index);
        if let Some(name) = segment.strip_prefix(':') {
            if !is_valid_param_name(name) {
                return Err(invalid_route(format!(
                    "route `{}` contains invalid dynamic segment `{segment}`",
                    route.path
                )));
            }
            if !matches!(
                expected,
                Some(RouteParam {
                    name: expected_name,
                    kind: RouteParamKind::Dynamic,
                }) if expected_name == name
            ) {
                return Err(invalid_route(format!(
                    "route `{}` contains reserved or mismatched segment `{segment}`",
                    route.path
                )));
            }
            param_index += 1;
            continue;
        }
        if let Some(raw_name) = segment.strip_prefix('*') {
            if index + 1 != segments.len() {
                return Err(invalid_route(format!(
                    "route `{}` has a non-terminal catch-all segment `{segment}`",
                    route.path
                )));
            }
            let optional = raw_name.ends_with('?');
            let name = raw_name.strip_suffix('?').unwrap_or(raw_name);
            if !is_valid_param_name(name) {
                return Err(invalid_route(format!(
                    "route `{}` contains invalid catch-all segment `{segment}`",
                    route.path
                )));
            }
            let matches_param = match expected {
                Some(RouteParam {
                    name: expected_name,
                    kind: RouteParamKind::CatchAll,
                }) => !optional && expected_name == name,
                Some(RouteParam {
                    name: expected_name,
                    kind: RouteParamKind::OptionalCatchAll,
                }) => optional && expected_name == name,
                _ => false,
            };
            if !matches_param {
                return Err(invalid_route(format!(
                    "route `{}` contains reserved or mismatched segment `{segment}`",
                    route.path
                )));
            }
            param_index += 1;
            continue;
        }

        if matches!(*segment, "." | "..")
            || !is_request_reachable_static_segment(segment)
            || segment
                .chars()
                .any(|character| matches!(character, ':' | '*' | '?' | '#' | '[' | ']'))
        {
            return Err(invalid_route(format!(
                "route `{}` contains reserved or non-normalized segment `{segment}`",
                route.path
            )));
        }
    }

    if param_index != route.params.len() {
        return Err(invalid_route(format!(
            "route `{}` parameter metadata does not match its path",
            route.path
        )));
    }
    Ok(())
}

fn is_request_reachable_static_segment(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if !byte.is_ascii_graphic() {
            return false;
        }
        if byte == b'%' {
            let Some(high) = bytes.get(index + 1).copied().and_then(route_hex_value) else {
                return false;
            };
            let Some(low) = bytes.get(index + 2).copied().and_then(route_hex_value) else {
                return false;
            };
            if matches!((high << 4) | low, b'.' | b'/' | b'\\') {
                return false;
            }
            index += 2;
        }
        index += 1;
    }
    true
}

fn route_hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_valid_param_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

#[derive(Clone, Copy)]
enum PatternSegment<'a> {
    Static(&'a str),
    Dynamic,
    CatchAll { optional: bool },
}

fn pattern_segments(path: &str) -> Vec<PatternSegment<'_>> {
    if path == "/" {
        return Vec::new();
    }
    path.trim_start_matches('/')
        .split('/')
        .map(|segment| {
            if segment.starts_with(':') {
                PatternSegment::Dynamic
            } else if let Some(name) = segment.strip_prefix('*') {
                PatternSegment::CatchAll {
                    optional: name.ends_with('?'),
                }
            } else {
                PatternSegment::Static(segment)
            }
        })
        .collect()
}

fn route_patterns_overlap(left: &str, right: &str) -> bool {
    let left = pattern_segments(left);
    let right = pattern_segments(right);
    let mut index = 0;

    loop {
        match (left.get(index), right.get(index)) {
            (None, None) => return true,
            (Some(PatternSegment::CatchAll { optional }), None)
            | (None, Some(PatternSegment::CatchAll { optional })) => return *optional,
            (Some(PatternSegment::CatchAll { .. }), Some(_))
            | (Some(_), Some(PatternSegment::CatchAll { .. })) => return true,
            (Some(PatternSegment::Static(left)), Some(PatternSegment::Static(right)))
                if left != right =>
            {
                return false;
            }
            (Some(_), Some(_)) => index += 1,
            (Some(_), None) | (None, Some(_)) => return false,
        }
    }
}

fn invalid_route(reason: String) -> RouterError {
    RouterError::InvalidRouteSegment(reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_page(root: &Path, route: &str) {
        let directory = root.join(route);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("page.tsx"), "").unwrap();
    }

    #[test]
    fn rejects_group_routes_with_the_same_canonical_path() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write_page(&app, "(first)/about");
        write_page(&app, "(second)/about");

        let error = scan_app_dir(&app).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("duplicate canonical path `/about`")
        );
    }

    #[test]
    fn rejects_dynamic_routes_with_the_same_matching_shape() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write_page(&app, "posts/[id]");
        write_page(&app, "posts/[slug]");

        let error = scan_app_dir(&app).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("ambiguous route patterns `/posts/:id`")
        );
    }

    #[test]
    fn rejects_every_intersecting_route_pattern_class() {
        let cases = [
            ("about", "[slug]"),
            ("shop/[id]/edit", "shop/sale/[action]"),
            ("docs/about", "docs/[...slug]"),
            ("docs", "docs/[[...slug]]"),
            ("docs/[...slug]", "docs/[[...rest]]"),
            ("[...slug]", "about/team"),
            ("posts/[id]", "posts/[...slug]"),
        ];

        for (left, right) in cases {
            let temp = tempfile::tempdir().unwrap();
            let app = temp.path().join("app");
            write_page(&app, left);
            write_page(&app, right);

            let error = scan_app_dir(&app).unwrap_err();
            assert!(
                error.to_string().contains("ambiguous route patterns"),
                "expected `{left}` and `{right}` to overlap, got {error}"
            );
        }
    }

    #[test]
    fn rejects_non_terminal_catch_alls_and_duplicate_param_names() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write_page(&app, "docs/[...slug]/edit");
        let error = scan_app_dir(&app).unwrap_err();
        assert!(error.to_string().contains("non-terminal catch-all"));

        fs::remove_dir_all(&app).unwrap();
        write_page(&app, "accounts/[id]/posts/[id]");
        let error = scan_app_dir(&app).unwrap_err();
        assert!(error.to_string().contains("repeats parameter `id`"));
    }

    #[test]
    fn accepts_distinct_static_dynamic_and_terminal_catch_all_routes() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write_page(&app, "about");
        write_page(&app, "posts/[id]");
        write_page(&app, "docs/[...slug]");

        let routes = scan_app_dir(&app).unwrap();
        assert_eq!(
            routes
                .iter()
                .map(|route| route.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/about", "/docs/*slug", "/posts/:id"]
        );

        fs::remove_dir_all(&app).unwrap();
        write_page(&app, "docs");
        write_page(&app, "docs/[...slug]");
        let routes = scan_app_dir(&app).unwrap();
        assert_eq!(
            routes
                .iter()
                .map(|route| route.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/docs", "/docs/*slug"]
        );
    }

    #[test]
    fn rejects_static_routes_that_cannot_reach_the_http_matcher() {
        let cases = [
            "hello world",
            "abc%20 ",
            "check-✓",
            "%",
            "%2",
            "%2F",
            "%2e",
            "%5C",
            "%ZZ",
        ];

        for route in cases {
            let temp = tempfile::tempdir().unwrap();
            let app = temp.path().join("app");
            write_page(&app, route);

            let error = scan_app_dir(&app).unwrap_err();
            assert!(
                error.to_string().contains("reserved or non-normalized"),
                "expected `{route}` to be rejected before route publication, got {error}"
            );
        }
    }

    #[test]
    fn accepts_static_percent_escapes_supported_by_the_http_matcher() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write_page(&app, "%20");
        write_page(&app, "%68ello");
        write_page(&app, "double-%252F");
        write_page(&app, "lower-%6a");
        write_page(&app, "upper-%4A");

        let routes = scan_app_dir(&app).unwrap();
        assert_eq!(
            routes
                .iter()
                .map(|route| route.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "/%20",
                "/%68ello",
                "/double-%252F",
                "/lower-%6a",
                "/upper-%4A"
            ]
        );
    }

    #[test]
    fn public_route_validation_rejects_non_normalized_and_malformed_paths() {
        let cases = [
            Route {
                path: "/docs/".to_owned(),
                file: "app/docs/page.tsx".into(),
                layouts: vec![],
                loading: None,
                error: None,
                params: vec![],
            },
            Route {
                path: "/docs//x".to_owned(),
                file: "app/docs/x/page.tsx".into(),
                layouts: vec![],
                loading: None,
                error: None,
                params: vec![],
            },
            Route {
                path: "/docs/../x".to_owned(),
                file: "app/docs/x/page.tsx".into(),
                layouts: vec![],
                loading: None,
                error: None,
                params: vec![],
            },
            Route {
                path: "/*slug??".to_owned(),
                file: "app/docs/page.tsx".into(),
                layouts: vec![],
                loading: None,
                error: None,
                params: vec![RouteParam {
                    name: "slug?".to_owned(),
                    kind: RouteParamKind::OptionalCatchAll,
                }],
            },
        ];

        for route in cases {
            let output = tempfile::NamedTempFile::new().unwrap();
            let error = write_route_types(&[route], output.path()).unwrap_err();
            assert!(
                error.to_string().contains("route"),
                "unexpected validation failure: {error}"
            );
        }
    }

    #[test]
    fn route_type_generation_refuses_to_overwrite_an_owned_file() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("notes.txt");
        fs::write(&output, "keep this source file\n").unwrap();

        let error = write_route_types(&[], &output).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("non-generated route types output")
        );
        assert_eq!(
            fs::read_to_string(output).unwrap(),
            "keep this source file\n"
        );
    }

    #[test]
    fn public_route_types_output_validation_distinguishes_owned_files() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing.d.ts");
        let generated = temp.path().join("generated.d.ts");
        let foreign = temp.path().join("foreign.d.ts");
        let directory = temp.path().join("directory.d.ts");
        fs::write(
            &generated,
            format!("{GENERATED_ROUTE_TYPES_HEADER}\nstable\n"),
        )
        .unwrap();
        fs::write(&foreign, "export type UserSource = true;\n").unwrap();
        fs::create_dir(&directory).unwrap();

        validate_route_types_output(&missing).unwrap();
        validate_route_types_output(&generated).unwrap();
        let error = validate_route_types_output(&foreign).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("non-generated route types output")
        );
        let error = validate_route_types_output(&directory).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("non-generated route types output")
        );
    }

    #[test]
    fn route_types_output_validation_preserves_metadata_errors() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("x".repeat(1024));

        let error = validate_route_types_output(&output).unwrap_err();

        assert!(matches!(
            error,
            RouterError::Io(ref source) if source.kind() != io::ErrorKind::NotFound
        ));
    }

    #[test]
    fn route_type_generation_can_refresh_its_own_output() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("routes.d.ts");
        fs::write(&output, format!("{GENERATED_ROUTE_TYPES_HEADER}\nstale\n")).unwrap();

        write_route_types(&[], &output).unwrap();

        let current = fs::read_to_string(output).unwrap();
        assert!(current.starts_with(GENERATED_ROUTE_TYPES_HEADER));
        assert!(current.contains("export type RoutePath = never;"));
    }

    #[test]
    fn route_type_generation_preserves_previous_output_when_staging_fails() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("routes.d.ts");
        let previous = format!("{GENERATED_ROUTE_TYPES_HEADER}\nstable\n");
        fs::write(&output, &previous).unwrap();

        let error = write_route_types_with(
            &[],
            &output,
            |file, contents| {
                file.write_all(&contents[..1])?;
                Err(io::Error::new(
                    io::ErrorKind::StorageFull,
                    "injected staging failure",
                ))
            },
            |_| Ok(()),
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(error.to_string().contains("injected staging failure"));
        assert_eq!(fs::read_to_string(&output).unwrap(), previous);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);

        write_route_types(&[], &output).unwrap();
        assert!(
            fs::read_to_string(output)
                .unwrap()
                .contains("export type RoutePath = never;")
        );
    }

    #[test]
    fn route_type_generation_stages_next_to_the_destination() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("routes.d.ts");

        write_route_types_with(
            &[],
            &output,
            |file, contents| {
                file.write_all(contents)?;
                file.flush()
            },
            |path| {
                let parent = path.parent().expect("output must have a parent");
                let staged_entries = fs::read_dir(parent)?
                    .filter_map(std::result::Result::ok)
                    .filter(|entry| entry.path() != path)
                    .count();
                if staged_entries == 1 {
                    Ok(())
                } else {
                    Err(io::Error::other(format!(
                        "expected one staged sibling, found {staged_entries}"
                    )))
                }
            },
            |_| Ok(()),
        )
        .unwrap();

        assert!(
            fs::read_to_string(output)
                .unwrap()
                .contains("export type RoutePath = never;")
        );
    }

    #[test]
    fn route_type_generation_does_not_clobber_a_concurrent_creator() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("routes.d.ts");

        let error = write_route_types_with(
            &[],
            &output,
            |file, contents| {
                file.write_all(contents)?;
                file.flush()
            },
            |path| fs::write(path, "foreign source\n"),
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("non-generated route types output")
        );
        assert_eq!(fs::read_to_string(&output).unwrap(), "foreign source\n");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn route_type_generation_does_not_clobber_a_post_validation_creator() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("routes.d.ts");

        let error = write_route_types_with(
            &[],
            &output,
            |file, contents| {
                file.write_all(contents)?;
                file.flush()
            },
            |_| Ok(()),
            |path| fs::write(path, "late foreign source\n"),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            RouterError::Io(ref source) if source.kind() == io::ErrorKind::AlreadyExists
        ));
        assert_eq!(
            fs::read_to_string(&output).unwrap(),
            "late foreign source\n"
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn route_type_generation_never_writes_through_a_swapped_symlink() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("routes.d.ts");
        let sentinel = temp.path().join("sentinel.txt");
        fs::write(&output, format!("{GENERATED_ROUTE_TYPES_HEADER}\nstable\n")).unwrap();
        fs::write(&sentinel, "do not modify\n").unwrap();

        write_route_types_with(
            &[],
            &output,
            |file, contents| {
                file.write_all(contents)?;
                file.flush()
            },
            |_| Ok(()),
            |path| {
                fs::remove_file(path)?;
                symlink(&sentinel, path)
            },
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "do not modify\n");
        assert!(fs::symlink_metadata(&output).unwrap().file_type().is_file());
        assert!(
            fs::read_to_string(&output)
                .unwrap()
                .contains("export type RoutePath = never;")
        );
    }

    #[cfg(unix)]
    #[test]
    fn route_type_generation_preserves_output_that_becomes_read_only() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("routes.d.ts");
        let previous = format!("{GENERATED_ROUTE_TYPES_HEADER}\nstable\n");
        fs::write(&output, &previous).unwrap();
        fs::set_permissions(&output, fs::Permissions::from_mode(0o640)).unwrap();

        let error = write_route_types_with(
            &[],
            &output,
            |file, contents| {
                file.write_all(contents)?;
                file.flush()
            },
            |path| fs::set_permissions(path, fs::Permissions::from_mode(0o440)),
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            RouterError::Io(ref source) if source.kind() == io::ErrorKind::PermissionDenied
        ));
        assert_eq!(fs::read_to_string(&output).unwrap(), previous);
        assert_eq!(
            fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o440
        );
    }

    #[cfg(unix)]
    #[test]
    fn route_type_generation_preserves_expected_file_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let baseline = temp.path().join("baseline.d.ts");
        let created = temp.path().join("created.d.ts");
        fs::write(&baseline, "baseline\n").unwrap();

        write_route_types(&[], &created).unwrap();
        assert_eq!(
            fs::metadata(&created).unwrap().permissions().mode() & 0o777,
            fs::metadata(&baseline).unwrap().permissions().mode() & 0o777,
            "new generated output must honor the process umask like fs::write"
        );

        let refreshed = temp.path().join("refreshed.d.ts");
        fs::write(
            &refreshed,
            format!("{GENERATED_ROUTE_TYPES_HEADER}\nstable\n"),
        )
        .unwrap();
        fs::set_permissions(&refreshed, fs::Permissions::from_mode(0o640)).unwrap();
        write_route_types(&[], &refreshed).unwrap();
        assert_eq!(
            fs::metadata(&refreshed).unwrap().permissions().mode() & 0o777,
            0o640
        );

        for mode in [0o440, 0o460, 0o442] {
            fs::set_permissions(&refreshed, fs::Permissions::from_mode(mode)).unwrap();
            let before = fs::read(&refreshed).unwrap();
            let error = write_route_types(&[], &refreshed).unwrap_err();
            assert!(matches!(
                error,
                RouterError::Io(ref source) if source.kind() == io::ErrorKind::PermissionDenied
            ));
            assert_eq!(
                fs::read(&refreshed).unwrap(),
                before,
                "mode {mode:o} must not be replaced through parent-directory rename authority"
            );
        }
    }
}
