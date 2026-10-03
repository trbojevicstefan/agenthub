'use strict';
// Whether an agent's model can see images, which the Opaya browser needs: agents read pages as text, but screenshots,
// charts, captchas and image-only buttons are pictures. true = can see, false = text only, null = unknown model.
// Names are matched loosely (provider prefixes, dates and sizes vary), newest families first.
const VISION=[
  /claude/i,/\b(opus|sonnet|haiku)\b/i,                                   // every Claude 3+ model
  /gpt-?4o/i,/gpt-?4\.1/i,/gpt-?4-?(turbo|vision)/i,/gpt-?[5-9]/i,/\bo[134](-|$|\b)/i,/codex/i,/computer-use/i,
  /gemini/i,/gemma-?[34]/i,                                               // Gemini, Gemma 3 and later
  /grok-?([2-9](-vision)?|vision)/i,
  /(qwen.*-?vl|qvq|qwen2\.5-?omni|qwen3-?(vl|omni))/i,
  /llama-?3\.2.*vision/i,/llama-?[4-9]/i,/llava/i,/bakllava/i,/moondream/i,/minicpm-?v/i,/internvl/i,/phi-?[34].*vision/i,/phi-?4-?multimodal/i,
  /pixtral/i,/mistral-?(small|medium)-?(3\.[1-9]|2[5-9]|latest)/i,/mistral-?medium/i,/mistral-?large-?(3|latest)/i,
  /kimi.*(vl|k2\.5)/i,/glm-?4(\.\d)?v/i,/glm-?[5-9].*v/i,/nova-?(lite|pro|premier)/i
];
// Newer models of families that were text only, which read images natively. Checked before TEXT_ONLY.
// DeepSeek V4.1 Flash: "deepseek-flash" on DeepSeek's API (also deepseek-flash-latest), deepseek/deepseek-v4.1-flash on
// OpenRouter; the retired V4 Flash Vision Exp. Plain deepseek-v4-flash and deepseek-v4-pro stay text only.
const NATIVE_VISION=[/deepseek[-_/:]?(v4\.1-?)?flash(-latest)?(?![\w.-]*(?:lite|text))/i,/deepseek-v4\.1-flash/i,/v4-flash-vision/i];
const TEXT_ONLY=[
  /deepseek/i,/gpt-?oss/i,/gpt-?3\.5/i,/\bqwen[23](\.\d)?(:|-|\b)(?!.*vl)/i,/qwq/i,/codestral/i,/devstral/i,/ministral/i,/mistral-?(7b|tiny|nemo)/i,/mixtral/i,
  /llama-?3(\.[01])?(:|-|\b)(?!.*vision)/i,/llama-?2/i,/phi-?[23](?!.*vision)/i,/\bglm-?4(\.\d)?(?!v)\b/i,/kimi-?k2(?!\.5)/i,/minimax/i,/hermes-?[234]/i,/command-?r/i,/granite/i,/smollm/i,/tinyllama/i
];
function visionOf(agent,{model=''}={}){
  const m=String(model||agent?.activeModel||agent?.model||'').trim();
  // The agent itself decides the model when none is set: Claude Code and Codex always use vision models.
  const native=agent?.provider==='claude'?'Claude':agent?.provider==='codex'?'GPT':'';
  if(m&&NATIVE_VISION.some(r=>r.test(m)))return {vision:true,model:m,reason:`${m} can see images.`};
  if(m&&TEXT_ONLY.some(r=>r.test(m))&&!VISION.some(r=>r.test(m)&&/vl|vision|omni|v\b/i.test(m)))return {vision:false,model:m,reason:`${m} reads text only; it cannot see screenshots or images.`};
  if(m&&VISION.some(r=>r.test(m)))return {vision:true,model:m,reason:`${m} can see images.`};
  if(native&&(!m||/^(default|sonnet|opus|haiku|opusplan)$/i.test(m)))return {vision:true,model:m||native,reason:`${native} models can see images.`};
  if(!m)return {vision:null,model:'',reason:'Opaya does not know which model this agent uses. The browser works only if that model can see images.'};
  return {vision:null,model:m,reason:`Opaya does not know whether ${m} can see images.`};
}
// Shown to the user: which models the Opaya browser works with.
const SUPPORTED='Claude (all), DeepSeek V4.1 Flash (deepseek-flash), GPT-4o, GPT-4.1 and GPT-5 and later, o3/o4, Gemini, Gemma 3, Grok, Qwen-VL, Llama 3.2 Vision and Llama 4, Pixtral, Mistral Small 3.1+ and Medium, LLaVA';
const UNSUPPORTED='DeepSeek V4 Pro and older DeepSeek, Qwen3 (text), QwQ, gpt-oss, Llama 3.1, Codestral, Devstral, Mixtral, MiniMax';
module.exports={visionOf,SUPPORTED,UNSUPPORTED};
