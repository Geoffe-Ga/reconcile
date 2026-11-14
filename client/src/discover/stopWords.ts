/**
 * The words kinship never counts (#428): English words that say nothing about what a
 * text is about, so two texts that share only these share nothing.
 *
 * It is a general list, not one fitted to any sample: function words and their
 * contractions without the apostrophe, number words, the days and months (an entry's
 * "Come on Saturday" is no kinship), words for spans of time, a few vague adjectives,
 * the commonest verbs in their forms, and the words every group's writing uses about
 * itself ("our community", "we believe", "join the meeting"). Words are checked as
 * written, before stemming, so each form a word takes is listed. "March" and "may"
 * stay off the months: they are also a protest and a verb ("may" is listed as a verb).
 */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  `
  about above across after afterwards again against all almost alone along already also
  although always among and another any anybody anyone anything anyway anywhere are around
  away became because become becomes been before behind being below beside besides between
  beyond both but can cannot could did does doing done down during each either else
  elsewhere enough even ever every everybody everyone everything everywhere except few for
  from further had has have having hence her here hers herself him himself his how however
  into its itself just last least less many may maybe meanwhile might mine more moreover
  most mostly much must myself neither never nevertheless next nobody none noone nor not
  nothing now nowhere off often once only onto other others otherwise our ours ourselves
  out over own per perhaps quite rather same several shall she should since some somebody
  somehow someone something sometimes somewhere soon still such than that the their theirs
  them themselves then there thereby therefore these they this those though through
  throughout thus together too toward towards under unless until upon very via was well
  were what whatever when whenever where wherever whether which while who whoever whole
  whom whose why will with within without would yet you your yours yourself yourselves

  dont wont cant isnt arent wasnt werent didnt doesnt hasnt havent hadnt shouldnt wouldnt
  couldnt youre theyre weve ive youve theyve youll theyll thats theres heres whats

  one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty
  sixty seventy eighty ninety hundred thousand million first second third twice

  monday tuesday wednesday thursday friday saturday sunday january february april june
  july august september october november december

  today tonight tomorrow yesterday day days week weeks month months year years time times
  way ways thing things lot lots kind sort part

  new old good great big little long really back

  ask asks asked get gets got getting give gives gave given going went gone come comes
  came coming know knows knew known take takes took taken see sees saw seen think thinks
  thought look looks looked want wants wanted use uses used using find finds found tell
  tells told seem seems seemed feel feels felt try tries tried leave leaves left call calls
  called keep keeps kept let lets put puts mean means meant bring brings brought happen
  happens happened need needs needed like likes liked say says said make makes made

  group groups member members community communities people everyone join joins joined
  meet meets meeting meetings please thank thanks believe believes
  `
    .split(/\s+/)
    .filter((word) => word !== ''),
);
