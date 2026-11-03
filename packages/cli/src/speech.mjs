import { runModelJob } from './model-jobs.mjs';
import { parseSpeechInput,createSpeechOriginal,validSpeechOriginal,verifySpeechTask } from '../../protocol/speech.mjs';
export const runSpeech = args => runModelJob(args, { family:'speech-syntheses',discards:'speech-discards',discardAction:'speech.discard',parseInput:parseSpeechInput,createOriginal:createSpeechOriginal,validOriginal:validSpeechOriginal,verifyTask:verifySpeechTask,requestError:'invalid_speech_request',notFound:'speech_not_found' });
