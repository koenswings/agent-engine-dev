/**
 * Kid stable fixture / content pins for duration UI Intents (idea#168 / App#10).
 * Auth Morango IDs are re-provision mutable — do not hard-fail walks on them.
 * Content IDs (video/exercise/channel) are stable across re-provision.
 */
export const DURATION_UI_FIXTURES = {
    kolibri: {
        diskId: 'duration-kolibri-grade5a-001',
        instanceId: 'kolibri-grade5a-001',
        packPath: 'tests/duration-tests/fixtures/kolibri',
        channelId: '30b6c263-4b96-5a62-93bd-dcf9a5cad7ca',
        /** open_video — CONTENT.seeded / CONTENT.live intentResolution */
        video: {
            contentId: 'e60662de-b15c-52f9-b003-359f7d91f8fd',
            nodeId: '4a1a1b92-3f6d-59eb-a94c-3f91f0011dd5',
        },
        /** open_exercise */
        exercise: {
            contentId: '7eb9de46-96eb-53d0-bcc1-2fb270b96f03',
            nodeId: '94a47ec7-f30d-5cd1-93f8-ad08c42b6c2a',
        },
        /** Live Kolibri on idea01 (Atlas); port 18080 behind Engine :80 proxy. */
        live: {
            host: 'idea01',
            dataDir: '/home/pi/idea166-kolibri-live/',
            kolibriHttpPort: 18080,
            consoleBaseUrlHint: 'http://idea01', // Engine :80 — NOT Vite 5173
        },
    },
    nextcloud: {
        diskId: 'duration-nextcloud-grade5a-001',
        instanceId: 'nextcloud-grade5a-001',
        packPath: 'tests/duration-tests/fixtures/nextcloud',
    },
} as const

/** Pixel Console Intent names registered in agent-console-dev#134 e2e/intents. */
export const PIXEL_REGISTERED_INTENTS = [
    'open_console_as_teacher',
    'open_console_as_learner',
    'open_console_as_operator',
    'return_to_start',
    'stay_on_teacher_overview',
    'stay_on_learner_overview',
    'stay_on_overview',
    'open_kolibri_as_teacher',
    'open_kolibri_as_learner',
    'open_nextcloud_as_teacher',
    'open_nextcloud_as_learner',
    'open_video',
    'open_exercise',
    'open_disk_inventory',
    'open_instance_controls',
    'eject_disk',
    'confirm_eject',
    'cancel_eject',
    'erase_disk',
    'confirm_erase',
    'cancel_erase',
    'start_instance',
    'stop_instance',
    'open_account',
    'close_account',
    'open_settings',
    'close_settings',
    'sign_in',
    'make_files_disk',
    'add_files_role',
] as const

export type PixelIntentName = (typeof PIXEL_REGISTERED_INTENTS)[number]

/** Known YAML Intents not in Pixel registry — clear deferred message, never silent. */
export const DEFERRED_UI_INTENTS = [
    'keep_watching',
    'next_resource',
    'exit_lesson',
    'open_wikipedia_as_teacher',
    'open_wikipedia_as_learner',
] as const

export const isPixelIntent = (name: string): name is PixelIntentName =>
    (PIXEL_REGISTERED_INTENTS as readonly string[]).includes(name)

export const isDeferredUiIntent = (name: string): boolean =>
    (DEFERRED_UI_INTENTS as readonly string[]).includes(name)

/** Resolve default disk/instance for an Intent from Kid pins. */
export const defaultIdsForIntent = (action: string): { diskId?: string; instanceId?: string } => {
    if (action.includes('nextcloud')) {
        return {
            diskId: DURATION_UI_FIXTURES.nextcloud.diskId,
            instanceId: DURATION_UI_FIXTURES.nextcloud.instanceId,
        }
    }
    if (
        action.includes('kolibri') ||
        action === 'open_video' ||
        action === 'open_exercise' ||
        action === 'open_disk_inventory' ||
        action === 'open_instance_controls' ||
        action === 'eject_disk' ||
        action === 'start_instance' ||
        action === 'stop_instance'
    ) {
        return {
            diskId: DURATION_UI_FIXTURES.kolibri.diskId,
            instanceId: DURATION_UI_FIXTURES.kolibri.instanceId,
        }
    }
    return {
        diskId: DURATION_UI_FIXTURES.kolibri.diskId,
        instanceId: DURATION_UI_FIXTURES.kolibri.instanceId,
    }
}
