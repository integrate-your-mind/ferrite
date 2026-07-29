use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    InvalidTagName(String),
    InvalidAttributeName(String),
    VoidElementHasChildren(String),
    NonFiniteNumberAttribute(String),
    OutputLimitExceeded(usize),
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::InvalidTagName(name) => {
                write!(f, "invalid HTML tag name `{name}`")
            }
            CoreError::InvalidAttributeName(name) => {
                write!(f, "invalid HTML attribute name `{name}`")
            }
            CoreError::VoidElementHasChildren(tag) => {
                write!(f, "void HTML element `{tag}` cannot have children")
            }
            CoreError::NonFiniteNumberAttribute(name) => {
                write!(f, "attribute `{name}` contains a non-finite number")
            }
            CoreError::OutputLimitExceeded(limit) => {
                write!(f, "rendered HTML exceeds the {limit}-byte output limit")
            }
        }
    }
}

impl std::error::Error for CoreError {}

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AttributeValue {
    String(String),
    Bool(bool),
    Number(f64),
}

impl From<&str> for AttributeValue {
    fn from(value: &str) -> Self {
        AttributeValue::String(value.to_owned())
    }
}

impl From<String> for AttributeValue {
    fn from(value: String) -> Self {
        AttributeValue::String(value)
    }
}

impl From<bool> for AttributeValue {
    fn from(value: bool) -> Self {
        AttributeValue::Bool(value)
    }
}

impl From<i32> for AttributeValue {
    fn from(value: i32) -> Self {
        AttributeValue::Number(value.into())
    }
}

impl From<f64> for AttributeValue {
    fn from(value: f64) -> Self {
        AttributeValue::Number(value)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Element {
    tag: String,
    attributes: BTreeMap<String, AttributeValue>,
    children: Vec<Node>,
}

impl Element {
    pub fn try_new<I, K>(tag: impl AsRef<str>, attributes: I, children: Vec<Node>) -> Result<Self>
    where
        I: IntoIterator<Item = (K, AttributeValue)>,
        K: Into<String>,
    {
        let tag = tag.as_ref().to_owned();
        validate_tag_name(&tag)?;

        if is_void_element(&tag) && !children.is_empty() {
            return Err(CoreError::VoidElementHasChildren(tag));
        }

        let mut normalized = BTreeMap::new();
        for (name, value) in attributes {
            let name = name.into();
            validate_attribute_name(&name)?;
            normalized.insert(name, value);
        }

        Ok(Self {
            tag,
            attributes: normalized,
            children,
        })
    }

    pub fn tag(&self) -> &str {
        &self.tag
    }

    pub fn attributes(&self) -> &BTreeMap<String, AttributeValue> {
        &self.attributes
    }

    pub fn children(&self) -> &[Node] {
        &self.children
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Node {
    Element(Element),
    Text(String),
    Fragment(Vec<Node>),
}

pub fn element<I, K>(tag: impl AsRef<str>, attributes: I, children: Vec<Node>) -> Result<Node>
where
    I: IntoIterator<Item = (K, AttributeValue)>,
    K: Into<String>,
{
    Element::try_new(tag, attributes, children).map(Node::Element)
}

pub fn text(value: impl Into<String>) -> Node {
    Node::Text(value.into())
}

pub fn fragment(children: Vec<Node>) -> Node {
    Node::Fragment(children)
}

pub fn render_to_html(node: &Node) -> Result<String> {
    let mut out = String::new();
    render_node(node, &mut out)?;
    Ok(out)
}

fn render_node(node: &Node, out: &mut String) -> Result<()> {
    match node {
        Node::Text(value) => {
            escape_text(value, out);
        }
        Node::Fragment(children) => {
            for child in children {
                render_node(child, out)?;
            }
        }
        Node::Element(element) => {
            out.push('<');
            out.push_str(element.tag());

            for (name, value) in element.attributes() {
                match value {
                    AttributeValue::Bool(true) => {
                        out.push(' ');
                        out.push_str(name);
                    }
                    AttributeValue::Bool(false) => {}
                    AttributeValue::String(value) => {
                        out.push(' ');
                        out.push_str(name);
                        out.push_str("=\"");
                        escape_attribute(value, out);
                        out.push('"');
                    }
                    AttributeValue::Number(value) => {
                        if !value.is_finite() {
                            return Err(CoreError::NonFiniteNumberAttribute(name.clone()));
                        }

                        out.push(' ');
                        out.push_str(name);
                        out.push_str("=\"");
                        out.push_str(&format_number(*value));
                        out.push('"');
                    }
                }
            }

            out.push('>');

            if !is_void_element(element.tag()) {
                for child in element.children() {
                    render_node(child, out)?;
                }
                out.push_str("</");
                out.push_str(element.tag());
                out.push('>');
            }
        }
    }

    Ok(())
}

fn validate_tag_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err(CoreError::InvalidTagName(name.to_owned()));
    };

    if !first.is_ascii_alphabetic() {
        return Err(CoreError::InvalidTagName(name.to_owned()));
    }

    if chars.all(|char| char.is_ascii_alphanumeric() || char == '-') {
        Ok(())
    } else {
        Err(CoreError::InvalidTagName(name.to_owned()))
    }
}

fn validate_attribute_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err(CoreError::InvalidAttributeName(name.to_owned()));
    };

    if !(first.is_ascii_alphabetic() || first == '_' || first == ':') {
        return Err(CoreError::InvalidAttributeName(name.to_owned()));
    }

    if chars.all(|char| char.is_ascii_alphanumeric() || matches!(char, '-' | '_' | ':' | '.')) {
        Ok(())
    } else {
        Err(CoreError::InvalidAttributeName(name.to_owned()))
    }
}

fn escape_text(value: &str, out: &mut String) {
    for char in value.chars() {
        match char {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(char),
        }
    }
}

fn escape_attribute(value: &str, out: &mut String) {
    for char in value.chars() {
        match char {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(char),
        }
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
    fn renders_nested_html_and_escapes_text_and_attributes() {
        let no_attributes = std::iter::empty::<(&str, AttributeValue)>;
        let tree = element(
            "main",
            [
                ("class", AttributeValue::from("shell")),
                ("data-count", AttributeValue::from(3)),
                ("hidden", AttributeValue::from(false)),
            ],
            vec![
                element("h1", no_attributes(), vec![text("Ferrite <Core>")]).unwrap(),
                element(
                    "button",
                    [("aria-label", AttributeValue::from("Increment \"count\""))],
                    vec![text("Count & grow")],
                )
                .unwrap(),
            ],
        )
        .unwrap();

        assert_eq!(
            render_to_html(&tree).unwrap(),
            "<main class=\"shell\" data-count=\"3\"><h1>Ferrite &lt;Core&gt;</h1><button aria-label=\"Increment &quot;count&quot;\">Count &amp; grow</button></main>"
        );
    }

    #[test]
    fn renders_boolean_and_void_attributes() {
        let tree = element(
            "input",
            [
                ("disabled", AttributeValue::from(true)),
                ("checked", AttributeValue::from(false)),
                ("value", AttributeValue::from("yes")),
            ],
            vec![],
        )
        .unwrap();

        assert_eq!(
            render_to_html(&tree).unwrap(),
            "<input disabled value=\"yes\">"
        );
    }

    #[test]
    fn rejects_invalid_tag_names() {
        let error = element(
            "script>alert",
            std::iter::empty::<(&str, AttributeValue)>(),
            vec![],
        )
        .unwrap_err();
        assert_eq!(error, CoreError::InvalidTagName("script>alert".to_owned()));
    }

    #[test]
    fn rejects_invalid_attribute_names() {
        let error = element(
            "div",
            [("data bad", AttributeValue::from("unsafe"))],
            vec![],
        )
        .unwrap_err();
        assert_eq!(
            error,
            CoreError::InvalidAttributeName("data bad".to_owned())
        );
    }

    #[test]
    fn rejects_void_elements_with_children() {
        let error = element(
            "img",
            std::iter::empty::<(&str, AttributeValue)>(),
            vec![text("bad")],
        )
        .unwrap_err();
        assert_eq!(error, CoreError::VoidElementHasChildren("img".to_owned()));
    }

    #[test]
    fn rejects_non_finite_number_attributes_at_render_time() {
        let tree = element(
            "div",
            [("data-value", AttributeValue::from(f64::NAN))],
            vec![],
        )
        .unwrap();
        let error = render_to_html(&tree).unwrap_err();
        assert_eq!(
            error,
            CoreError::NonFiniteNumberAttribute("data-value".to_owned())
        );
    }
}
