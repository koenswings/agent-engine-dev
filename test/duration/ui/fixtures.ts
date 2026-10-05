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
    /** Console#135 @ 198eb69 / Kid App#11 Prefer A Kiwix stub (not infra_disk until Atlas docks). */
    kiwix: {
        diskId: 'duration-kiwix-ideaa-001',
        instanceId: 'kiwix-ideaa-001',
        packPath: 'tests/duration-tests/fixtures/kiwix',
    },
} as const

/** Pixel Console Intent names registered in agent-console-dev e2e/intents (85 @ 198eb69; was 76 @ 2da863c). */
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
    // Nextcloud share (Console#135 @ 953af05)
    'share_to_class',
    // leave nc_share (Console#135 @ 1709165)
    'done_sharing',
    'back_to_console_from_share',
    // Collab doc Viewer (Console#135 @ 2da863c)
    'open_collab_doc',
    'close_doc',
    // keep_editing on NC Text (Console#135 @ 1bbb729 / tip 198eb69)
    'keep_editing',
    // File Drop trio (Console#135 @ 198eb69) — names match cover-all.yaml
    'open_file_drop',
    'after_upload',
    'leave_file_drop',
    // Wikipedia / Kiwix stub (Console#135 @ 1bbb729 / tip 198eb69) — names match cover-all.yaml
    'open_wikipedia_as_teacher',
    'open_wikipedia_as_learner',
    'search_browse_wikipedia',
    'leave_wikipedia_as_teacher',
    'leave_wikipedia_as_learner',
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

/** Known YAML Intents not in Pixel registry — clear deferred message, never silent. Empty @ 198eb69 (wiki + File Drop undeferred). */
export const DEFERRED_UI_INTENTS = [] as const

/**
 * Proposal Intents on unified.yaml still not in Pixel's 85-key registry (@ 198eb69).
 * StubUiDriver Fake no-ops; live --ui clear-miss until Pixel adapters — do not drop YAML edges.
 * keep_watching is registered (Console#134 @ 329dc38).
 * next_resource is registered (Console#135 @ f16ee18).
 * finish_exercise is registered (Console#135 @ d087081).
 * next_video is registered (Console#135 @ a8b4b6c).
 * exit_lesson is registered (Console#135 @ 549f72b).
 * browse_folders is registered (Console#135 @ f150b9e).
 * share_to_class is registered (Console#135 @ 953af05).
 * done_sharing / back_to_console_from_share are registered (Console#135 @ 1709165).
 * open_collab_doc / close_doc are registered (Console#135 @ 2da863c).
 * keep_editing + Wikipedia open/search/leave are registered (Console#135 @ 1bbb729).
 * File Drop trio is registered (Console#135 @ 198eb69).
 * PIXEL_MISSING empty @ 198eb69.
 */
export const PIXEL_MISSING_INTENTS = [] as const

export const isPixelIntent = (name: string): name is PixelIntentName =>
    (PIXEL_REGISTERED_INTENTS as readonly string[]).includes(name)

export const isDeferredUiIntent = (name: string): boolean =>
    (DEFERRED_UI_INTENTS as readonly string[]).includes(name)

export const isPixelMissingUiIntent = (name: string): boolean =>
    (PIXEL_MISSING_INTENTS as readonly string[]).includes(name)

/** Resolve default disk/instance for an Intent from Kid pins. */
export const defaultIdsForIntent = (action: string): { diskId?: string; instanceId?: string } => {
    if (
        action.includes('nextcloud') ||
        action === 'keep_editing' ||
        action === 'open_collab_doc' ||
        action === 'close_doc' ||
        action === 'browse_folders' ||
        action === 'share_to_class' ||
        action === 'done_sharing' ||
        action === 'back_to_console_from_share' ||
        action === 'open_file_drop' ||
        action === 'after_upload' ||
        action === 'leave_file_drop'
    ) {
        return {
            diskId: DURATION_UI_FIXTURES.nextcloud.diskId,
            instanceId: DURATION_UI_FIXTURES.nextcloud.instanceId,
        }
    }
    if (action.includes('wikipedia') || action.includes('kiwix')) {
        return {
            diskId: DURATION_UI_FIXTURES.kiwix.diskId,
            instanceId: DURATION_UI_FIXTURES.kiwix.instanceId,
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
    // Prefer A r20 FAIL@92: files / backup EmptyDiskPanel Intents must target the
    // empty (or Files) disk under test — never hard-code moved Kolibri Grade5A.
    // files_role_added asserts disk-view / files badge on this id (DURATION_FILES_DISK_ID
    // after make_files_disk when set by the harness).
    // Prefer A r22 FAIL@93: add_files_role targets an app-only disk (Add Files on an
    // Apps DiskView) — DURATION_ADD_FILES_DISK_ID else Kolibri Grade5A (the harness
    // restores it onto the Console engine first). Never the make_files_disk Files Disk.
    if (action === 'add_files_role') {
        return { diskId: process.env.DURATION_ADD_FILES_DISK_ID?.trim() || DURATION_UI_FIXTURES.kolibri.diskId }
    }
    if (
        action === 'make_files_disk' ||
        action === 'files_role_added' ||
        action === 'make_backup_disk' ||
        action === 'restore_from_backup' ||
        action === 'backup_configured_restored' ||
        action === 'erase_disk'
    ) {
        const filesId = process.env.DURATION_FILES_DISK_ID?.trim()
        // Prefer A r22: files_role_added asserts the disk that most recently gained files.
        const lastFilesRole = process.env.DURATION_LAST_FILES_ROLE_DISK_ID?.trim()
        if (action === 'files_role_added' && lastFilesRole) {
            return { diskId: lastFilesRole }
        }
        if (
            filesId &&
            (action === 'files_role_added' ||
                action === 'backup_configured_restored' ||
                action === 'restore_from_backup')
        ) {
            return { diskId: filesId }
        }
        const emptyId =
            process.env.DURATION_EMPTY_DISK_ID?.trim() || DURATION_UI_FIXTURES.empty.diskId
        return { diskId: emptyId }
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
