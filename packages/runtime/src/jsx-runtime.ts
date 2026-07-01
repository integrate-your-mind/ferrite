import { Fragment, createElement, type Child, type ElementType, type Key, type VNode } from "./index.js";

export { Fragment };

export function jsx<P extends Record<string, unknown>>(
  type: ElementType<P>,
  props: P & { key?: Key | null; children?: Child },
  key?: Key,
): VNode<P> {
  return createElement(type, key === undefined ? props : { ...props, key });
}

export const jsxs = jsx;

export namespace JSX {
  export type Element = VNode | Promise<VNode>;

  export interface ElementChildrenAttribute {
    children: {};
  }

  export interface IntrinsicAttributes {
    key?: Key;
  }

  export interface IntrinsicElements {
    [elementName: string]: Record<string, unknown>;
  }
}
