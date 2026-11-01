import type { ProtonDriveClient } from '@protontech/drive-sdk';

/**
 * The part of `ProtonDriveClient` this project uses. The fake drive's
 * `SdkSurface` implements the same pick, so tests never reach Proton.
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
