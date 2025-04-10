import { Atom } from '../core/atom-class';
import type { ElementInfo, Offset, Range } from '../public/core-types';
import { OriginValidator } from '../public/options';
import { _Mathfield } from './mathfield-private';

export type Rect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

/**
 * Checks if the argument is a valid Mathfield.
 * After a Mathfield has been destroyed (for example by calling `dispose()`
 * the Mathfield is no longer valid. However, there may be some pending
 * operations invoked via requestAnimationFrame() for example, that would
 * need to ensure the mathfield is still valid by the time they're executed.
 */
export function isValidMathfield(mf: _Mathfield): boolean {
  return mf.element?.mathfield === mf;
}

/**
 * Return the element which has the caret
 */
function findElementWithCaret(element: Element): Element | null {
  return (
    element.querySelector('.ML__caret') ??
    element.querySelector('.ML__text-caret') ??
    element.querySelector('.ML__latex-caret')
  );
}

/**
 * Return the (x,y) client coordinates of the caret in viewport coordinates
 */
export function getCaretPoint(
  element: Element
): { x: number; y: number; height: number } | null {
  const caret = findElementWithCaret(element);
  if (!caret) return null;
  const bounds = caret.getBoundingClientRect();
  return {
    x: bounds.right,
    y: bounds.bottom,
    height: bounds.height,
  };
}

function branchId(atom: Atom): string {
  if (!atom.parent) return 'root';
  let result = atom.parent.id ?? '';
  result +=
    typeof atom.parentBranch === 'string'
      ? '-' + atom.parentBranch
      : `-${atom.parentBranch![0]}/${atom.parentBranch![0]}`;
  return result;
}

export function adjustForScrolling(
  mathfield: _Mathfield,
  rect: Rect | null,
  scaleFactor: number
): Rect | null {
  if (!rect) return null;
  const fieldRect = mathfield.field!.getBoundingClientRect();
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  const left = Math.ceil(
    rect.left - fieldRect.left + mathfield.field.scrollLeft * scaleFactor
  );

  const top = Math.ceil(rect.top - fieldRect.top);
  return { left, right: left + w, top, bottom: top + h };
}

function getNodeBounds(node: Element): Rect {
  const bounds = node.getBoundingClientRect();
  const marginRight = parseInt(getComputedStyle(node).marginRight);
  const result: Rect = {
    top: bounds.top - 1,
    bottom: bounds.bottom,
    left: bounds.left,
    right: bounds.right - 1 + marginRight,
  };
  if (node.children.length === 0 || node.tagName.toUpperCase() === 'SVG')
    return result;

  for (const child of node.children) {
    if (
      child.nodeType === 1 &&
      'atomId' in (child as HTMLElement).dataset &&
      !child.classList.contains('ML__pstrut')
    ) {
      const r: Rect = getNodeBounds(child);
      result.left = Math.min(result.left, r.left);
      result.right = Math.max(result.right, r.right);
      result.top = Math.min(result.top, r.top);
      result.bottom = Math.max(result.bottom, r.bottom);
    }
  }

  return result;
}

export function getAtomBounds(mathfield: _Mathfield, atom: Atom): Rect | null {
  if (!atom.id) return null;
  let result: Rect | null = mathfield.atomBoundsCache?.get(atom.id) ?? null;
  if (result !== null) return result;
  const node = mathfield.field.querySelector(`[data-atom-id="${atom.id}"]`);
  result = node ? getNodeBounds(node) : null;
  if (mathfield.atomBoundsCache) {
    if (result) mathfield.atomBoundsCache.set(atom.id, result);
    else mathfield.atomBoundsCache.delete(atom.id);
  }
  return result ?? null;
}

export function getRangeBoundingRect(mf: _Mathfield, range: Range): Rect {
  const [start, end] = range;

  // Inspect each bounding rect, and calculate the maximum
  // top, bottom, left, and right
  let result: Rect | null = null;
  for (let i = start; i <= end; i++) {
    const bounds = getAtomBounds(mf, mf.model.at(i));
    if (bounds) {
      if (!result) {
        result = bounds;
      } else {
        result.top = Math.min(result.top, bounds.top);
        result.bottom = Math.max(result.bottom, bounds.bottom);
        result.left = Math.min(result.left, bounds.left);
        result.right = Math.max(result.right, bounds.right);
      }
    }
  }

  return result ?? { top: 0, bottom: 0, left: 0, right: 0 };
}

/*
 * Return an array of bounds for the specified range, at most
 * one rect per branch.
 */
function getRangeBounds(
  mathfield: _Mathfield,
  range: Range,
  options?: { excludeAtomsWithBackground?: boolean }
): Rect[] {
  // The key of the map is a 'branchId', i.e. "atom id + branch"
  const rects = new Map<string, Rect>();

  // Logic to accommodate mathfield hosted in an isotropically
  // scale-transformed element.
  // Without this, the selection indicator will not be in the right place.

  // 1. Inquire how big the mathfield thinks it is
  const field = mathfield.field;
  const offsetWidth = field.offsetWidth;

  // 2. Get the actual screen width of the box
  const actualWidth = Math.floor(field.getBoundingClientRect().width);

  // 3. Divide the two to get the scale factor
  let scaleFactor = actualWidth / offsetWidth;
  scaleFactor = isNaN(scaleFactor) ? 1 : scaleFactor;

  for (const atom of mathfield.model.getAtoms(range, {
    includeChildren: true,
  })) {
    if (options?.excludeAtomsWithBackground && atom.style.backgroundColor)
      continue;

    const bounds = adjustForScrolling(
      mathfield,
      getAtomBounds(mathfield, atom),
      scaleFactor
    );
    if (bounds) {
      const id = branchId(atom);
      if (rects.has(id)) {
        const r = rects.get(id)!;
        rects.set(id, {
          left: Math.min(r.left, bounds.left),
          right: Math.max(r.right, bounds.right),
          top: Math.min(r.top, bounds.top),
          bottom: Math.max(r.bottom, bounds.bottom),
        });
      } else rects.set(id, bounds);
    }
  }

  return [...rects.values()];
}

export function getSelectionBounds(
  mathfield: _Mathfield,
  options?: { excludeAtomsWithBackground?: boolean }
): Rect[] {
  return mathfield.model.selection.ranges.reduce(
    (acc: Rect[], x) => acc.concat(...getRangeBounds(mathfield, x, options)),
    []
  );
}

export function validateOrigin(
  origin: string,
  originValidator: OriginValidator
): boolean {
  if (origin === '*' || originValidator === 'none') return true;

  if (originValidator === 'same-origin')
    return !window.origin || origin === window.origin;

  if (typeof originValidator === 'function') return originValidator(origin);

  return false;
}

/**
 * Calculates a DOMRect like getBoundingClientRect
 * but excluding any CSS transforms
 */
export function getLocalDOMRect(el: HTMLElement): DOMRect {
  let offsetTop = 0;
  let offsetLeft = 0;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  while (el instanceof HTMLElement) {
    offsetTop += el.offsetTop;
    offsetLeft += el.offsetLeft;
    el = el.offsetParent as HTMLElement;
  }

  return new DOMRect(offsetLeft, offsetTop, width, height);
}

export function getElementInfo(
  mf: _Mathfield | undefined | null,
  offset: Offset
): ElementInfo | undefined {
  if (!mf) return undefined;

  const atom = mf.model.at(offset);
  if (!atom) return undefined;

  const result: ElementInfo = {};

  const bounds = getAtomBounds(mf, atom);
  if (bounds) {
    result.bounds = new DOMRect(
      bounds.left,
      bounds.top,
      bounds.right - bounds.left,
      bounds.bottom - bounds.top
    );
  }

  result.depth = atom.treeDepth - 2;

  result.style = atom.style;

  // Look for some 'htmlData' in the atom or its ancestors
  let a: undefined | Atom = atom;
  while (a) {
    if (a.command === '\\htmlData' && a.args && typeof a.args[0] === 'string') {
      const entries = a.args[0].split(',');
      for (const entry of entries) {
        const matched = entry.match(/([^=]+)=(.+$)/);
        if (matched) {
          const key = matched[1].trim().replace(/ /g, '-');
          if (key) {
            if (!result.data) result.data = {};
            result.data[key] = matched[2];
          }
        } else {
          const key = entry.trim().replace(/ /g, '-');
          if (key) {
            if (!result.data) result.data = {};
            result.data[key] = undefined;
          }
        }
      }
    }

    if (a.command === '\\htmlId' || a.command === '\\cssId') {
      if (!result.id && a.args && typeof a.args[0] === 'string')
        result.id = a.args[0];
    }
    a = a.parent;
  }

  if (atom.mode === 'math' || atom.mode === 'text')
    result.latex = Atom.serialize([atom], { defaultMode: 'math' });

  return result;
}

export function getHref(mf: _Mathfield, offset: Offset): string {
  let a: Atom | undefined = mf.model.at(offset);
  while (a) {
    if (a.command === '\\href') {
      const url = a.args[0];
      if (typeof url === 'string') return url;
    }

    a = a.parent;
  }
  return '';
}
