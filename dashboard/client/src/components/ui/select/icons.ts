// Inline SVG icons for the select components, so no icon package is needed.
import type { FunctionalComponent, SVGAttributes } from 'vue'
import { h } from 'vue'

function icon(d: string): FunctionalComponent<SVGAttributes> {
  return (_props, { attrs }) =>
    h(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
        ...attrs,
      },
      [h('path', { d })],
    )
}

export const CheckIcon = icon('M20 6 9 17l-5-5')
export const ChevronDownIcon = icon('m6 9 6 6 6-6')
export const ChevronUpIcon = icon('m18 15-6-6-6 6')
