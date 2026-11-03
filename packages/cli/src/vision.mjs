import { runModelJob } from './model-jobs.mjs';
import { parseVisionInput,createVisionOriginal,validVisionOriginal,verifyVisionTask,visionRequestBytes } from '../../protocol/vision.mjs';
export const runVision = args => runModelJob(args,{family:'vision-observations',discards:'vision-discards',discardAction:'vision.discard',parseInput:parseVisionInput,createOriginal:createVisionOriginal,validOriginal:validVisionOriginal,verifyTask:verifyVisionTask,requestError:'invalid_vision_request',notFound:'vision_not_found',maxInputBytes:visionRequestBytes});
