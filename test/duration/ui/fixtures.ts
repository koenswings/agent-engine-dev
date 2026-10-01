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

/** Pixel Console Intent names registered in agent-console-dev#134 e2e/intents (65 @ ba0cfa1). */
export const PIXEL_REGISTERED_INTENTS = [
    'open_console_as_teacher',
    'open_console_as_learner',
    'open_console_as_operator',
    'return_to_start',
    'stay_on_teacher_overview',
    'stay_on_learner_overview',
    'stay_on_overview',
    'open_kolibri_as_teacher', // /en/coach/#/classes
    'open_kolibri_as_learner',
    'open_nextcloud_as_teacher',
    'open_nextcloud_as_learner',
    'open_video',
    'open_exercise',
    // Pixel coaching set (Console#134 @ ba0cfa1)
    'create_class',
    'enroll_learners',
    'build_lesson',
    'create_quiz',
    'read_reports',
    'preview_as_learner',
    'browse_classes',
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
    // operator deep
    'install_app',
    'start_after_install',
    'stay_on_disk',
    'make_backup_disk',
    'restore_from_backup',
    'open_app',
    'backup_instance',
    'back_to_disk',
    'back_to_overview',
    'log_out',
    'notice_usb_dock',
    'retry_login_first_time_setup',
    'change_password',
    'add_operator',
    'remove_operator',
    'copy_app',
    'move_app',
    // Part B leftovers + leave/back (Console#134 @ ba0cfa1)
    'files_role_added',
    'backup_configured_restored',
    'done_redistribute',
    'stay_on_source_disk',
    'open_copied_instance',
    'switch_engine',
    'reboot_engine',
    'back_to_console', // hardened in Console#134 @ ba0cfa1
    'leave_kolibri',
    'leave_nextcloud_as_teacher',
    'leave_nextcloud_as_learner',
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

/**
 * Proposal Intents on unified.yaml still not in Pixel's 65-key registry (@ ba0cfa1).
 * StubUiDriver Fake no-ops; live --ui clear-miss until Pixel adapters — do not drop YAML edges.
 * Lesson chrome keep_watching/next_resource/exit_lesson + open_wikipedia_* live under DEFERRED_UI_INTENTS.
 */
export const PIXEL_MISSING_INTENTS = [
    // Kolibri navigation (finish_exercise/next_video not deferred — clear Fake no-op)
    'finish_exercise',
    'next_video',
    // Nextcloud deep
    'share_to_class',
    'done_sharing',
    'back_to_console_from_share',
    'open_file_drop',
    'after_upload',
    'leave_file_drop',
    'open_collab_doc',
    'close_doc',
    'keep_editing',
    'browse_folders',
    // Wikipedia leave/search (open_* deferred)
    'search_browse_wikipedia',
    'leave_wikipedia_as_learner',
    'leave_wikipedia_as_teacher',
] as const

export const isPixelIntent = (name: string): name is PixelIntentName =>
    (PIXEL_REGISTERED_INTENTS as readonly string[]).includes(name)

export const isDeferredUiIntent = (name: string): boolean =>
    (DEFERRED_UI_INTENTS as readonly string[]).includes(name)

export const isPixelMissingUiIntent = (name: string): boolean =>
    (PIXEL_MISSING_INTENTS as readonly string[]).includes(name)

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
