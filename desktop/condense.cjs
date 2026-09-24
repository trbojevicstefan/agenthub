'use strict';
// Condense a chat to its essence. Uses the Opaya Agent's model API when it has an API key (cheap, and the agent's own
// session is untouched); otherwise asks the chat's own agent in the same chat, where it already has the full context.
const PROMPT='Condense this conversation to its essence: the goal, the decisions made, the important facts, commands, file paths and results, and what is still open. Write short Markdown with these headings: Goal, Key points, Decisions, Open items. Leave out small talk and repetition. Answer in the language the conversation is in.';
const AGENT_PROMPT=`Opaya: ${PROMPT} Condense everything we discussed in this chat so far. Do not run tools or change anything.`;
// The transcript as plain text. Very long chats keep their start and their most recent part.
function transcriptText(messages,agentName,max=120000){
  const text=messages.filter(m=>m.content&&(m.role==='user'||m.role==='assistant')).map(m=>`${m.role==='user'?'User':agentName}:\n${m.content}`).join('\n\n');
  if(text.length<=max)return text;
  const head=Math.floor(max*.25);return `${text.slice(0,head)}\n\n[... ${text.length-max} characters left out ...]\n\n${text.slice(text.length-(max-head))}`;
}
async function condense({broker,opaya,id,progress=()=>{}}){
  const c=broker.conversation(id),a=broker.agent(c.agentId);
  progress({step:'read',state:'active',message:`Reading "${c.title}"`});
  const messages=await broker.messagesOf(c.id),real=messages.filter(m=>m.content&&(m.role==='user'||m.role==='assistant'));
  if(real.length<2)throw new Error('This chat is too short to condense.');
  const words=real.reduce((n,m)=>n+String(m.content).split(/\s+/).length,0);
  progress({step:'read',state:'done',message:`${real.length} messages, about ${words.toLocaleString('en-US')} words`});
  const model=opaya?.summarizer?.();let text,by;
  if(model){
    progress({step:'condense',state:'active',message:`Condensing with ${model}`});
    const r=await opaya.summarize([{role:'system',content:PROMPT},{role:'user',content:transcriptText(messages,a.name)}]);
    text=r.text;by=model;if(r.usage?.total_tokens)progress({message:`Used ${r.usage.total_tokens.toLocaleString('en-US')} tokens`});
  }else{
    progress({step:'condense',state:'active',message:`No Opaya model API key, so ${a.name} condenses its own chat`});
    if(broker.runtimeFor(a.id).status!=='connected'){progress({message:`Connecting ${a.name}`});await broker.connect(a.id);}
    const sent=await broker.send({agentId:a.id,conversationId:c.id,text:AGENT_PROMPT});
    const turn=broker.turns.get(a.id);if(turn)await turn.done;
    const reply=(await broker.messagesOf(c.id)).find(m=>m.id===sent.messageId);
    if(!reply||reply.status!=='done'||!reply.content)throw new Error(reply?.error||`${a.name} did not return a summary.`);
    text=reply.content;by=a.name;
  }
  progress({step:'condense',state:'done',message:`Condensed to ${text.split(/\s+/).length} words`});
  progress({step:'save',state:'active',message:'Saving the essence with the chat'});
  const essence=await broker.setEssence(c.id,{text,by});
  progress({step:'save',state:'done',message:'Saved'});
  return {conversationId:c.id,title:c.title,agentId:a.id,essence};
}
module.exports={condense,transcriptText,PROMPT,AGENT_PROMPT};
