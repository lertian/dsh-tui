/**
 * A windowed highlight list shared by the slash-command menu and the picker
 * dialogs. It is purely presentational: the caller owns the keyboard handling
 * and the filtered item list.
 * @module @deepseek-ai/dsh-tui-app/ui/select-list
 */

import { Box, Text } from 'ink'
import type { ReactNode } from 'react'

/** One selectable row: a value handed back on confirm plus its display text. */
export interface SelectItem {
  readonly value: string
  readonly label: string
  readonly description?: string
}

interface SelectListProps {
  /** The already-filtered rows, best first. */
  readonly items: readonly SelectItem[]
  /** The highlighted row index into `items`. */
  readonly selectedIndex: number
  /** How many rows render at once; the window follows the selection. */
  readonly maxVisible?: number
}

/** Render a highlight window over the rows; empty lists get a dim placeholder. */
export function SelectList({ items, selectedIndex, maxVisible = 8 }: SelectListProps): ReactNode {
  if (items.length === 0) return <Text dimColor>{'  (no matches)'}</Text>
  const half = Math.floor(maxVisible / 2)
  const start = Math.max(0, Math.min(selectedIndex - half, items.length - maxVisible))
  const visible = items.slice(start, start + maxVisible)
  return (
    <Box flexDirection="column">
      {visible.map((item, offset) => {
        const selected = start + offset === selectedIndex
        return (
          <Text key={item.value} inverse={selected}>
            {selected ? '› ' : '  '}
            {item.label}
            {item.description === undefined || item.description === '' ? '' : (
              <Text dimColor={!selected}>{`  ${item.description}`}</Text>
            )}
          </Text>
        )
      })}
    </Box>
  )
}
