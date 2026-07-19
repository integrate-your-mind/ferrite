mod legacy;

pub use legacy::{
    Route, RouteParam, RouteParamKind, RouterError, Result, find_document_file,
    generate_route_types,
};

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub fn scan_app_dir(app_dir: impl AsRef<Path>) -> Result<Vec<Route>> {
    let routes = legacy::scan_app_dir(app_dir)?;
    validate_route_table(&routes)?;
    Ok(routes)
}

pub fn write_route_types(routes: &[Route], output_path: impl AsRef<Path>) -> Result<()> {
    validate_route_table(routes)?;
    let output_path = output_path.as_ref();
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(output_path, generate_route_types(routes))?;
    Ok(())
}

fn validate_route_table(routes: &[Route]) -> Result<()> {
    let mut canonical_paths = BTreeMap::<&str, &Path>::new();
    let mut matching_shapes = BTreeMap::<String, (&str, &Path)>::new();

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

        let shape = matching_shape(&route.path);
        if let Some((first_path, first_file)) =
            matching_shapes.insert(shape.clone(), (&route.path, &route.file))
        {
            if first_path != route.path {
                return Err(invalid_route(format!(
                    "ambiguous matching shape `{shape}` for `{first_path}` in `{}` and `{}` in `{}`",
                    first_file.display(),
                    route.path,
                    route.file.display()
                )));
            }
        }
    }
    Ok(())
}

fn validate_route(route: &Route) -> Result<()> {
    if route.path != "/" && !route.path.starts_with('/') {
        return Err(invalid_route(format!(
            "route path `{}` is not absolute",
            route.path
        )));
    }

    let mut names = BTreeSet::new();
    for param in &route.params {
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
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut param_index = 0;
    for (index, segment) in segments.iter().enumerate() {
        let expected = route.params.get(param_index);
        if let Some(name) = segment.strip_prefix(':') {
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
    }

    if param_index != route.params.len() {
        return Err(invalid_route(format!(
            "route `{}` parameter metadata does not match its path",
            route.path
        )));
    }
    Ok(())
}

fn matching_shape(path: &str) -> String {
    if path == "/" {
        return "/".to_owned();
    }
    let segments = path
        .trim_start_matches('/')
        .split('/')
        .map(|segment| {
            if segment.starts_with(':') {
                ":"
            } else if segment.starts_with('*') {
                "*"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>();
    format!("/{}", segments.join("/"))
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
        assert!(error.to_string().contains("duplicate canonical path `/about`"));
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
                .contains("ambiguous matching shape `/posts/:`")
        );
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
    }
}
