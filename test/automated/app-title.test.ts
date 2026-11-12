/**
 * app-title.test.ts — idea#428: a compose without x-app.title must not feed
 * Automerge `undefined` (RangeError at /appDB/<id>/title).
 */
import { describe, it, expect } from 'vitest'
import { appTitleFromXapp } from '../../src/data/App.js'

describe('appTitleFromXapp (idea#428)', () => {
    it('uses a non-empty x-app.title', () => {
        expect(appTitleFromXapp({ title: 'Kolibri' }, 'kolibri')).toBe('Kolibri')
    })
    it('defaults to the app name when title is missing, blank, or x-app is absent', () => {
        expect(appTitleFromXapp({}, 'axle427')).toBe('axle427')
        expect(appTitleFromXapp({ title: '   ' }, 'axle427')).toBe('axle427')
        expect(appTitleFromXapp(undefined, 'axle427')).toBe('axle427')
        expect(appTitleFromXapp(null, 'axle427')).toBe('axle427')
    })
})
