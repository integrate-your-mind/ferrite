mod legacy;

pub use legacy::{
    GENERATED_ROUTE_TYPES_HEADER, Result, Route, RouteParam, RouteParamKind, RouterError,
    find_document_file, generate_route_types,
};

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Read};
use std::path::Path;

pub fn scan_app_dir(app_dir: impl AsRef<Path>) -> Result<Vec<Route>> {
    let routes = legacy::scan_app_dir(app_dir)?;
    validate_route_table(&routes)?;
    Ok(routes)
}

pub fn write_route_types(routes: &[Route], output_path: impl AsRef<Path>) -> Result<()> {
    validate_route_table(routes)?;
    let output_path = output_path.as_ref();
    validate_route_types_output(output_path)?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, generate_route_types(routes))?;
    Ok(())
}

pub fn validate_route_types_output(output_path: impl AsRef<Path>) -> Result<()> {
    let output_path = output_path.as_ref();
    let metadata = match fs::symlink_metadata(output_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
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
    Ok(())
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
    fn route_type_generation_can_refresh_its_own_output() {
        let temp = tempfile::tempdir().unwrap();
        let output = temp.path().join("routes.d.ts");
        fs::write(&output, format!("{GENERATED_ROUTE_TYPES_HEADER}\nstale\n")).unwrap();

        write_route_types(&[], &output).unwrap();

        let current = fs::read_to_string(output).unwrap();
        assert!(current.starts_with(GENERATED_ROUTE_TYPES_HEADER));
        assert!(current.contains("export type RoutePath = never;"));
    }
}
