import { processDriveRequirementHeaders, SUPPORTED_REQUIREMENT_MASK_BY_SCOPE } from '../../vendor/proton-drive-cli/apiRequirements';
import { MessageEmitter } from '../../vendor/proton-drive-cli/messageEmitter';
import type { Logger } from '../../vendor/proton-drive-sdk-account';

/**
 * Warns once per message when Proton's Drive requirement headers ask for a newer SDK or a
 * feature this build lacks. Only the client that talks to the real Proton API uses it.
 */
export function createRequirementHook(sdkVersion: string, logger: Logger) {
    const once = new MessageEmitter();
    const warn = (message: string) =>
        once.emitOnce(message, (msg) => {
            logger.warn(msg);
        });
    return (_request: Request, _options: unknown, response: Response) => {
        processDriveRequirementHeaders(response.headers, {
            clientSdkVersion: sdkVersion,
            supportedRequirementMasksByScope: SUPPORTED_REQUIREMENT_MASK_BY_SCOPE,
            onUnsupportedFeature: (scope, mask) => warn(`Proton says this SDK lacks a required feature for ${scope} (mask ${mask}). Update protium-drive.`),
            onRequiredUpdate: (version) => warn(`Proton requires SDK ${version} or newer (this build uses ${sdkVersion}). Update protium-drive.`),
            onSuggestedUpdate: (version) => warn(`Proton suggests SDK ${version} or newer (this build uses ${sdkVersion}).`),
        });
    };
}
