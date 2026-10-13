// Minimaler DOM-Helfer.
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'html') {
        el.innerHTML = String(v);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Setzt textContent nur bei Änderung (spart DOM-Arbeit im HUD). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setClass(el: HTMLElement, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** Segment-Auswahl (Buttons). */
export function segmented<T extends string | number | boolean>(
  options: { label: string; value: T; disabled?: boolean }[],
  value: T,
  onChange: (v: T) => void,
): HTMLDivElement {
  const wrap = h('div', { class: 'seg' });
  const render = (cur: T) => {
    clear(wrap);
    for (const o of options) {
      wrap.appendChild(
        h(
          'button',
          {
            class: o.value === cur ? 'on' : '',
            disabled: !!o.disabled,
            onclick: () => {
              if (o.disabled) return;
              render(o.value);
              onChange(o.value);
            },
          },
          o.label,
        ),
      );
    }
  };
  render(value);
  return wrap;
}

export function slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void, fmt: (v: number) => string = (v) => String(v)): [HTMLInputElement, HTMLSpanElement] {
  const out = h('span', { class: 'num' }, fmt(value));
  const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) }) as HTMLInputElement;
  inp.value = String(value);
  inp.addEventListener('input', () => {
    const v = Number(inp.value);
    out.textContent = fmt(v);
    onInput(v);
  });
  return [inp, out];
}
