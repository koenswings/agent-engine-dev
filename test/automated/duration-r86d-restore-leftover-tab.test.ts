/**
 * r86d FAIL@100 (cover-all-stage2-c0a7ea4-r86d): restoreApp ran and finished Done on idea04
 * (op tutoqx2ou973errs22r), and kolibri-grade5a-001 was Running on idea04:18080 with its sidecar owner
 * OK. The step still failed: "active tab http://idea03.local:61820 is not the store URL ...". That tab
 * was the Nextcloud Text tab left over from keep_editing. The b540743 restore Intent drives only the
 * Console page (its sidecar check is consolePage.request.get), so the tracker's "active" tab was never
 * this step's App use. Only for Console-only actions, a tab the step never touched (same seq, same URL,
 * not fresh) is now skipped. A tab that navigated or was opened during the step is still judged, and
 * every other action still judges the active tab.
 */
import { describe, expect, it } from 'vitest'
import { appTabProblems, untouchedLeftoverTab, CONSOLE_ONLY_APP_ACTIONS, type AppTab } from '../duration/appUrls.js'

const pin = { app: 'kolibri', instanceId: 'kolibri-grade5a-001', engine: 'idea04', port: 18080, url: 'http://10.99.0.14:18080', hosts: ['idea04', 'idea04.local', '10.99.0.14'] } as never
const consoleHosts = ['idea01', 'idea01.local', '10.99.0.11', 'idea03', 'idea03.local', '10.99.0.13', 'idea04', 'idea04.local', '10.99.0.14']
const consoleTab: AppTab = { url: 'http://idea01:8080/#/disk/duration-empty-002', active: false, fresh: false, console: true }
const ncLeft: AppTab = { url: 'http://idea03.local:61820/apps/files/?openfile=true', active: true, fresh: false, seq: 7 }

describe('r86d: restore_from_backup is not failed by a leftover Nextcloud tab', () => {
    it('restore_from_backup is a Console-only action', () => {
        expect(CONSOLE_ONLY_APP_ACTIONS.has('restore_from_backup')).toBe(true)
        expect(CONSOLE_ONLY_APP_ACTIONS.has('open_app')).toBe(false)
        expect(CONSOLE_ONLY_APP_ACTIONS.has('keep_editing')).toBe(false)
    })
    it('replay: untouched leftover active tab → no problem when the pre-step snapshot is given', () => {
        expect(appTabProblems([consoleTab, ncLeft], [pin], consoleHosts, undefined, [consoleTab, ncLeft])).toEqual([])
        expect(untouchedLeftoverTab(ncLeft, [ncLeft])).toBe(true)
    })
    it('without a snapshot (every other action) the old guard still fires', () => {
        const p = appTabProblems([consoleTab, ncLeft], [pin], consoleHosts)
        expect(p.join(' ')).toMatch(/active tab http:\/\/idea03\.local:61820 is not the store URL/)
    })
    it('a tab that navigated during the step is still judged', () => {
        const moved: AppTab = { ...ncLeft, url: 'http://idea03.local:61820/apps/text' }
        expect(appTabProblems([consoleTab, moved], [pin], consoleHosts, undefined, [consoleTab, ncLeft]).length).toBe(1)
    })
    it('a tab opened during the step (fresh) on the wrong Pi is still judged', () => {
        const fresh: AppTab = { url: 'http://10.99.0.11:18080/', active: true, fresh: true, seq: 9 }
        expect(appTabProblems([consoleTab, fresh], [pin], consoleHosts, undefined, [consoleTab, ncLeft]).length).toBe(1)
    })
    it('a correct kolibri tab passes either way', () => {
        const ok: AppTab = { url: 'http://10.99.0.14:18080/en/', active: true, fresh: true, seq: 9 }
        expect(appTabProblems([consoleTab, ok], [pin], consoleHosts, undefined, [consoleTab])).toEqual([])
    })
})
