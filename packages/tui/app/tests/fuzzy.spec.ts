/** Fuzzy subsequence matching: scoring, ranking, and filtering. */

import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from '../src/fuzzy.ts'

describe('fuzzyScore', () => {
  it('matches every query character in order or not at all', () => {
    expect(fuzzyScore('to', 'tools')).not.toBeNull()
    expect(fuzzyScore('tl', 'tools')).not.toBeNull()
    expect(fuzzyScore('ot', 'tools')).toBeNull()
    expect(fuzzyScore('zzz', 'tools')).toBeNull()
  })

  it('matches case-insensitively', () => {
    expect(fuzzyScore('TO', 'tools')).not.toBeNull()
  })

  it('matches everything on an empty query', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('prefers early, compact, and word-boundary matches', () => {
    expect(fuzzyScore('to', 'tools') ?? 0).toBeGreaterThan(fuzzyScore('to', 'truncated-output') ?? 0)
    expect(fuzzyScore('model', 'model') ?? 0).toBeGreaterThan(fuzzyScore('model', 'model-selection') ?? 0)
  })
})

describe('fuzzyFilter', () => {
  it('ranks the best subsequence match first and drops non-matches', () => {
    const names = ['new', 'resume', 'model', 'tools', 'settings', 'help', 'quit']
    expect(fuzzyFilter(names, 'to', name => name)).toEqual(['tools'])
    expect(fuzzyFilter(names, 're', name => name)[0]).toBe('resume')
    expect(fuzzyFilter(names, '', name => name)).toEqual(names)
  })

  it('keeps the input order on score ties', () => {
    expect(fuzzyFilter(['ab', 'ab'], 'ab', name => name)).toEqual(['ab', 'ab'])
  })
})
