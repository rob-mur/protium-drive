import type { ProtonDriveClient } from '@protontech/drive-sdk';

/**
 * The part of `ProtonDriveClient` this project uses. Tests implement it with
 * an in-memory fake (`tests/support/fakeSdk.ts`), so no test reaches Proton.
 */
export type DriveSdk = Pick<
    ProtonDriveClient,
    | 'getMyFilesRootFolder'
    | 'iterateFolderChildrenNodeUids'
    | 'iterateNodes'
    | 'getNode'
    | 'createFolder'
    | 'getFileUploader'
    | 'getFileRevisionUploader'
    | 'getFileDownloader'
    | 'trashNodes'
    | 'renameNode'
    | 'moveNodes'
    | 'getEventScheduler'
    | 'iterateEvents'
>;
