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
    empty: {
        diskId: 'duration-empty-001',
        packPath: 'tests/duration-tests/fixtures/empty',
        /** Pixel EmptyDiskPanel: DURATION_EMPTY_DISK_ID / data-role=empty */
        preferredDevice: 'idea-test-3',
    },
    /** Prefer A r17: Kid pack empty-002/ — erase discover after make_backup on empty-001. */
    empty2: {
        diskId: 'duration-empty-002',
        packPath: 'tests/duration-tests/fixtures/empty-002',
        preferredDevice: 'idea-test-4',
    },
} as const

/** Pixel Console Intent names registered in agent-console-dev e2e/intents (71 @ f150b9e; was 68 @ 4f7cfba). */
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
    // stay on pinned video URL (Console#134 @ 329dc38). No click.
    'keep_watching',
    // video → exercise via resource panel (Console#135 @ f16ee18)
    'next_resource',
    // exercise → Learn home via Perseus Check (Console#135 @ d087081)
    'finish_exercise',
    // exercise → video via resource panel (Console#135 @ a8b4b6c)
    'next_video',
    // video/exercise → Learn home via Kolibri chrome (Console#135 @ 549f72b)
    'exit_lesson',
    // Nextcloud Class Materials / Drop Zone / Collab (Console#135 @ f150b9e)
    'browse_folders',
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
    'open_wikipedia_as_teacher',
    'open_wikipedia_as_learner',
] as const

/**
 * Proposal Intents on unified.yaml still not in Pixel's 71-key registry (@ f150b9e).
 * StubUiDriver Fake no-ops; live --ui clear-miss until Pixel adapters — do not drop YAML edges.
 * open_wikipedia_* stay deferred.
 * keep_watching is registered (Console#134 @ 329dc38).
 * next_resource is registered (Console#135 @ f16ee18).
 * finish_exercise is registered (Console#135 @ d087081).
 * next_video is registered (Console#135 @ a8b4b6c).
 * exit_lesson is registered (Console#135 @ 549f72b).
 * browse_folders is registered (Console#135 @ f150b9e).
 */
export const PIXEL_MISSING_INTENTS = [
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
    // Prefer A r27: late install / start_after_install target empty-disk install uuid —
    // do NOT pass kolibri-grade5a-001 (Path A start_instance keeps grade5a below).
    if (action === 'install_app' || action === 'start_after_install') {
        return {
            diskId: DURATION_UI_FIXTURES.empty.diskId,
            // omit instanceId → Pixel discovers newly installed non-grade5a start-*
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
