import { runModelJob } from './model-jobs.mjs';
import { parseTextInput,createTextOriginal,validTextOriginal,verifyTextTask,textRequestBytes } from '../../protocol/text.mjs';
export const runText = args => runModelJob(args,{family:'text-generations',discards:'text-discards',discardAction:'text.discard',parseInput:parseTextInput,createOriginal:createTextOriginal,validOriginal:validTextOriginal,verifyTask:verifyTextTask,requestError:'invalid_text_request',notFound:'text_not_found',maxInputBytes:textRequestBytes});
