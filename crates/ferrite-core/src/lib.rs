#[allow(dead_code)]
mod legacy;

pub use legacy::{AttributeValue, CoreError, Element, Node, Result, element, fragment, text};

pub fn render_to_html(node: &Node) -> Result<String> {
    render_to_html_with_limit(node, usize::MAX)
}

pub fn render_to_html_with_limit(node: &Node, max_output_bytes: usize) -> Result<String> {
    let mut out = HtmlBuffer::new(max_output_bytes);
    render_node(node, &mut out)?;
    Ok(out.finish())
}

fn render_node(node: &Node, out: &mut HtmlBuffer) -> Result<()> {
    match node {
        Node::Text(value) => escape_text(value, out)?,
        Node::Fragment(children) => {
            for child in children {
                render_node(child, out)?;
            }
        }
        Node::Element(element) => {
            out.push('<')?;
            out.push_str(element.tag())?;
            for (name, value) in element.attributes() {
                render_attribute(name, value, out)?;
            }
            out.push('>')?;
            if !is_void_element(element.tag()) {
                for child in element.children() {
                    render_node(child, out)?;
                }
                out.push_str("</")?;
                out.push_str(element.tag())?;
                out.push('>')?;
            }
        }
    }
    Ok(())
}

fn render_attribute(name: &str, value: &AttributeValue, out: &mut HtmlBuffer) -> Result<()> {
    match value {
        AttributeValue::Bool(value) if is_html_boolean_attribute(name) => {
            if *value {
                out.push(' ')?;
                out.push_str(name)?;
            }
        }
        AttributeValue::Bool(value) => {
            write_quoted_attribute(name, if *value { "true" } else { "false" }, out)?
        }
        AttributeValue::String(value) => write_quoted_attribute(name, value, out)?,
        AttributeValue::Number(value) => {
            if !value.is_finite() {
                return Err(CoreError::NonFiniteNumberAttribute(name.to_owned()));
            }
            write_quoted_attribute(name, &format_number(*value), out)?;
        }
    }
    Ok(())
}

fn write_quoted_attribute(name: &str, value: &str, out: &mut HtmlBuffer) -> Result<()> {
    out.push(' ')?;
    out.push_str(name)?;
    out.push_str("=\"")?;
    escape_attribute(value, out)?;
    out.push('"')
}

fn is_html_boolean_attribute(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "allowfullscreen"
            | "async"
            | "autofocus"
            | "autoplay"
            | "capture"
            | "checked"
            | "controls"
            | "credentialless"
            | "default"
            | "defer"
            | "disabled"
            | "disablepictureinpicture"
            | "disableremoteplayback"
            | "download"
            | "formnovalidate"
            | "hidden"
            | "inert"
            | "ismap"
            | "itemscope"
            | "loop"
            | "multiple"
            | "muted"
            | "nomodule"
            | "novalidate"
            | "open"
            | "playsinline"
            | "readonly"
            | "required"
            | "reversed"
            | "scoped"
            | "seamless"
            | "selected"
    )
}

fn escape_text(value: &str, out: &mut HtmlBuffer) -> Result<()> {
    for char in value.chars() {
        match char {
            '&' => out.push_str("&amp;")?,
            '<' => out.push_str("&lt;")?,
            '>' => out.push_str("&gt;")?,
            _ => out.push(char)?,
        }
    }
    Ok(())
}

fn escape_attribute(value: &str, out: &mut HtmlBuffer) -> Result<()> {
    for char in value.chars() {
        match char {
            '&' => out.push_str("&amp;")?,
            '<' => out.push_str("&lt;")?,
            '>' => out.push_str("&gt;")?,
            '"' => out.push_str("&quot;")?,
            '\'' => out.push_str("&#39;")?,
            _ => out.push(char)?,
        }
    }
    Ok(())
}

struct HtmlBuffer {
    output: String,
    max_output_bytes: usize,
}

impl HtmlBuffer {
    fn new(max_output_bytes: usize) -> Self {
        Self {
            output: String::new(),
            max_output_bytes,
        }
    }

    fn push(&mut self, value: char) -> Result<()> {
        self.reserve(value.len_utf8())?;
        self.output.push(value);
        Ok(())
    }

    fn push_str(&mut self, value: &str) -> Result<()> {
        self.reserve(value.len())?;
        self.output.push_str(value);
        Ok(())
    }

    fn reserve(&self, additional: usize) -> Result<()> {
        if self
            .output
            .len()
            .checked_add(additional)
            .is_none_or(|size| size > self.max_output_bytes)
        {
            return Err(CoreError::OutputLimitExceeded(self.max_output_bytes));
        }
        Ok(())
    }

    fn finish(self) -> String {
        self.output
    }
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn is_void_element(tag: &str) -> bool {
    matches!(
        tag,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_html_boolean_and_string_boolean_attributes() {
        let tree = element(
            "div",
            [
                ("aria-hidden", AttributeValue::from(false)),
                ("data-ready", AttributeValue::from(true)),
                ("draggable", AttributeValue::from(false)),
                ("hidden", AttributeValue::from(false)),
            ],
            vec![],
        )
        .unwrap();

        assert_eq!(
            render_to_html(&tree).unwrap(),
            "<div aria-hidden=\"false\" data-ready=\"true\" draggable=\"false\"></div>"
        );
    }

    #[test]
    fn preserves_true_html_boolean_attributes() {
        let tree = element(
            "input",
            [
                ("disabled", AttributeValue::from(true)),
                ("checked", AttributeValue::from(false)),
            ],
            vec![],
        )
        .unwrap();
        assert_eq!(render_to_html(&tree).unwrap(), "<input disabled>");
    }

    #[test]
    fn preserves_overloaded_and_modern_boolean_attribute_semantics() {
        let tree = element(
            "video",
            [
                ("capture", AttributeValue::from(false)),
                ("credentialless", AttributeValue::from(false)),
                ("disablepictureinpicture", AttributeValue::from(true)),
                ("disableremoteplayback", AttributeValue::from(false)),
                ("download", AttributeValue::from("clip.mp4")),
            ],
            vec![],
        )
        .unwrap();

        assert_eq!(
            render_to_html(&tree).unwrap(),
            "<video disablepictureinpicture download=\"clip.mp4\"></video>"
        );
    }

    #[test]
    fn enforces_output_limit_during_escaping_across_multiple_nodes() {
        let tree = fragment(vec![
            element(
                "p",
                std::iter::empty::<(&str, AttributeValue)>(),
                vec![text("<&>")],
            )
            .unwrap(),
            element(
                "span",
                std::iter::empty::<(&str, AttributeValue)>(),
                vec![text("x")],
            )
            .unwrap(),
        ]);
        assert_eq!(
            render_to_html_with_limit(&tree, 34).unwrap(),
            "<p>&lt;&amp;&gt;</p><span>x</span>"
        );
        assert_eq!(
            render_to_html_with_limit(&tree, 33).unwrap_err(),
            CoreError::OutputLimitExceeded(33)
        );
    }
}
