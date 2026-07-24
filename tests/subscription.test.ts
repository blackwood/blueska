// Tests for isSkaRelated() gate logic in src/subscription.ts
//
// Add cases here whenever you find a new false positive or false negative.
// Run with: yarn test

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { isSkaRelated, isMentionSpam } from '../src/subscription'

function pass(text: string) {
  assert.equal(isSkaRelated(text), true, `Expected PASS: "${text}"`)
}

function fail(text: string) {
  assert.equal(isSkaRelated(text), false, `Expected FAIL: "${text}"`)
}

function spam(text: string) {
  assert.equal(isMentionSpam(text), true, `Expected SPAM: "${text}"`)
}

function notSpam(text: string) {
  assert.equal(isMentionSpam(text), false, `Expected NOT SPAM: "${text}"`)
}

// ---------------------------------------------------------------------------
// Mention spam filter
// ---------------------------------------------------------------------------

describe('mention spam filter', () => {
  test('mention flood (MutualMusic-style) → spam', () =>
    spam(
      '#MutualMusic 🇯🇲 Ska, Reggae, etc inspired songs\n' +
      '@user1.bsky.social\n@user2.bsky.social\n@user3.bsky.social\n' +
      '@user4.bsky.social\n@user5.bsky.social\n@user6.bsky.social\n' +
      '@user7.bsky.social\n@user8.bsky.social\n@user9.bsky.social',
    ))
  test('below floor (2 mentions) → not spam', () =>
    notSpam('Great ska show tonight! Thanks @friend1.bsky.social and @friend2.bsky.social'))
  test('3 mentions but plenty of prose → not spam', () =>
    notSpam('Saw Less Than Jake with @friend1 @friend2 @friend3 — best ska show in years, skanking all night'))
  test('hashtag-only (no mentions) → not spam', () =>
    notSpam('#ska #skaPunk #reggae great vibes tonight at the show'))
})

// ---------------------------------------------------------------------------
// High-confidence patterns — should always pass without music context
// ---------------------------------------------------------------------------

describe('high confidence: compound terms', () => {
  test('ska-punk', () => pass('Just released a new ska-punk EP'))
  test('ska-core', () => pass('Hardcore meets skacore at its finest'))
  test('skanking', () => pass('Everyone was skanking at the front of the pit'))
  test('#ska hashtag', () => pass('Loving this album #ska'))
  test('#blueska hashtag', () => pass('New release from the Toasters #blueska'))
  test('#blueska alone', () => pass('just discovered this band #blueska'))
  test('third wave ska', () => pass('Classic third wave ska energy'))
  test('2-tone ska', () => pass('2-tone ska was revolutionary'))
  test('rudeboy', () => pass('Proud rudeboy since 1999'))
  test('rudegirl', () => pass('Rudegirl forever'))
})

describe('high confidence: unambiguous artists', () => {
  test('Skatalites', () => pass('The Skatalites are the originators'))
  test('Operation Ivy', () => pass('Operation Ivy defined an era'))
  test('Less Than Jake', () => pass('Less Than Jake new album!'))
  test('Streetlight Manifesto', () => pass('Streetlight Manifesto tour dates announced'))
  test('Reel Big Fish', () => pass('Reel Big Fish are always fun live'))
  test('Mighty Mighty Bosstones', () => pass('Mighty Mighty Bosstones reunion show'))
  test('Toots and the Maytals', () => pass('Toots and the Maytals - reggae legends'))
  test('Desmond Dekker', () => pass('Desmond Dekker - Israelites is a classic'))
})

// ---------------------------------------------------------------------------
// Madness: structural classification (ported from madness_filter.py)
// ---------------------------------------------------------------------------

describe('Madness: clearly the band (should PASS)', () => {
  test('mid-sentence standalone - show context', () =>
    pass('Madness played a great show last night'))
  test('mid-sentence standalone - live context', () =>
    pass('I saw Madness live in 1984'))
  test('mid-sentence standalone - band context', () =>
    pass('I really love the band Madness'))
  test('coordinator stops right-flank scan — MEDIUM, ambiguous without music context', () =>
    fail('I love Madness and Blur'))
  test('comma stops right-flank scan — MEDIUM, "ska rules" alone not enough context', () =>
    fail('I love Madness, Blur and Oasis — ska rules'))
  test('sentence-initial + music context', () =>
    pass('Madness played a great show last night'))
  // Known limitation: "Saw" is capitalized (sentence-initial in English) and
  // directly precedes "Madness", so flankCount counts it as a flanking proper
  // noun → score 0.22 → REJECT. Common workaround: "just saw Madness live".
  test('sentence-initial word before Madness → REJECT (known limitation)', () =>
    fail('Saw Madness live last night!'))
})

describe('Madness: compound proper nouns (should FAIL)', () => {
  test('March Madness — direct adjacency (was regex gap before)', () =>
    fail('March Madness is on!'))
  test('March Madness with music context (was false positive before)', () =>
    fail('March Madness watch party with the band!'))
  test('Sound of Madness (Shinedown album)', () =>
    fail('Sound of Madness is a great album by Shinedown'))
  test('Midnight Madness with music context (was regex gap before)', () =>
    fail('Midnight Madness was a great show last night'))
  test('A Little Bit of Madness', () =>
    fail('A Little Bit of Madness'))
  test('The Madness of Markets (title in quotes)', () =>
    fail('"The Madness of Markets" is my book pick this week'))
  test('Shakespeare Festival Madness', () =>
    fail('Shakespeare Festival Madness — come join us!'))
  test('lowercase madness — common noun', () =>
    fail('the madness of it all'))
  test('title-list: Cap, Madness and Cap → REJECT (not rescuable by music context)', () =>
    fail('I suspect The Manchester Chronicles: True Tales of Music, Madness and Mayhem 1976–2006 by Clint Boon will be a gem.'))
})

describe('Madness: utterances and non-music standalone (should FAIL)', () => {
  test('gaming slang — mid-sentence, no music context', () =>
    fail('This dude just procd Madness on me smh'))
  test('"The Madness" as grammatical subject — political/metaphorical', () =>
    fail("The Madness is winning but it's time to kick myself out of the house for the weekly group ride which will help"))
  test('standalone reaction after ellipsis and newline', () =>
    fail('Uh oh... here we go again \u{1F614}\n\nMadness \u{1F92C}'))
  test('sentence-final utterance after full stop — political', () =>
    fail("All my life I've heard that if we give corporations and rich folks a break on their taxes, they'll make investments that bring good jobs for new employees and help current employees too.\n\nAnd, wow, I do not know how folks can keep expecting anyone to believe it. Madness."))
})

// ---------------------------------------------------------------------------
// Nordic ska exclusion
// ---------------------------------------------------------------------------

describe('Nordic ska: Swedish/Norwegian auxiliary verb (should FAIL)', () => {
  test('jag ska', () => fail('Jag ska göra det imorgon'))
  test('ska vara', () => fail('Det ska vara kul'))
  test('ska vi', () => fail('Ska vi gå på konsert?'))
  test('inverted du ska', () => fail('ska du komma?'))
  test('ska fram (directional particle)', () =>
    fail('Om sanningen ska fram (vill du ligga med mig då) och måste googla'))
  test('ska hem', () => fail('Jag ska hem nu'))
  test('ska dit', () => fail('Vi ska dit imorgon'))
})

describe('Nordic ska: rescued by English music signals', () => {
  test('Swedish + ska band context', () =>
    pass('Jag ska gå på ska gig ikväll!'))
})

// ---------------------------------------------------------------------------
// Ambiguous band names + music context
// ---------------------------------------------------------------------------

describe('ambiguous bands: require music context', () => {
  test('The Specials + gig', () => pass('The Specials gig was amazing'))
  test('the specials (lowercase) + gig — band context', () => pass('saw the specials last night — best gig in years'))
  test('the specials (lowercase) + "Listening to podcast" — not enough music context → blocked', () =>
    fail('Listening to @toohot4tv.bsky.social reminds me of SUCH fond memories of finding the latest DWM at the newsagent. But then I remember how local newsagents didn\'t carry the specials! They looked GORGEOUS but no realistic way I could get them here. Still regret that!'))
  test('Goldfinger + band', () => pass('Goldfinger is a great ska-punk band'))
  test('Bad Manners + concert', () => pass('Bad Manners concert tonight!'))
  test('Save Ferris + album', () => pass('Save Ferris album out now'))
  test('Suggs + live', () => pass('Suggs live at the Roundhouse was incredible'))
  test('Suggs without music context → blocked', () => fail('Suggs had a great season'))
})

describe('rocksteady gate', () => {
  // passes: genre/scene context
  test('rocksteady + ska (scene co-occurrence)', () =>
    pass('Stranger Cole, ska and rocksteady pioneer, has died'))
  test('rocksteady + lovers rock (scene)', () =>
    pass('388 cimbreado por el rocksteady y el lovers rock'))
  test('rocksteady + tune (music context)', () =>
    pass('even when it\'s a standard, run of the mill, rocksteady tune'))
  test('rock steady (space) + album', () =>
    pass('Listened through the debut album Take a Beat from The Doomstompers. Gritty soulful rock steady.'))
  test('#rocksteady hashtag', () => pass('#rocksteady #cancionesbonitas'))
  test('rocksteady + vinyl', () => pass('Found some great rocksteady vinyl'))
  test('rock-steady (hyphen) + vinyl', () => pass('Found some great rock-steady vinyl'))

  // fails: non-music senses
  test('rocksteady adjectival — "otherwise rocksteady run"', () =>
    fail('Cars was the first stumble in an otherwise rocksteady run'))
  test('rocksteady + rhinoceros → blocker', () =>
    fail('Rocksteady is a northern white rhinoceros. There are only two left.'))
  test('bebop + rocksteady (TMNT) → EXCLUDE_PATTERNS', () =>
    fail('bebop and rocksteady are iconic TMNT villains'))
  test('capital-R Rocksteady mid-sentence, no scene → proper noun',
    () => fail('I\'m not sure if i ever made it past Rocksteady back in the day'))
  test('#rocksteady + tmnt blocker', () =>
    fail('love #rocksteady and bebop from tmnt'))
})

describe('Goldfinger/Bond: Bond film exclusion', () => {
  test('James Bond film context → blocked', () =>
    fail('Although the most commonly cited favorite James Bond film is Goldfinger'))
  test('007 + Goldfinger → blocked', () =>
    fail('Goldfinger is my favorite 007 film, Sean Connery was perfect'))
  test('bond film alone → blocked', () =>
    fail('The bond film Goldfinger holds up well'))
  test('bond movie alone (no Goldfinger) → blocked', () =>
    fail('watched a great bond movie last night'))
  test('james bond alone (no Goldfinger) → blocked', () =>
    fail('James Bond is the best spy franchise'))
  test('music context rescues: band + 007 + Goldfinger', () =>
    // "band" hits MUSIC_CONTEXT → hasMusicCtx → rescue
    pass('my ska band covers the 007 Goldfinger theme'))
  test('high-confidence ska rescues: ska-punk + Bond villain', () =>
    pass('Goldfinger is a great ska-punk band, not just a Bond villain'))
})

// ---------------------------------------------------------------------------
// Exclusion patterns
// ---------------------------------------------------------------------------

describe('hard exclusions', () => {
  test('crypto: $ska', () => fail('Buy $ska now before it moons!'))
  test('crypto: ska coin', () => fail('ska coin is the next big thing'))
  test('geography: Alaska', () => fail('Visiting Alaska next month'))
  test('geography: Nebraska', () => fail('Nebraska is a big state'))
  test('TMNT: Bebop and Rocksteady (closed)', () =>
    fail('Bebop and Rocksteady are the best TMNT villains'))
  test('TMNT: reversed (closed)', () =>
    fail('Rocksteady and Bebop cause chaos'))
  test('TMNT: rock steady (space) and bebop', () =>
    fail('Joe Rogan is like if rock steady and bebop had a relationship'))
  test('TMNT: bebop and rock steady (space)', () =>
    fail('bebop and rock steady are iconic TMNT villains'))
  test('Arkham games', () => fail('Batman Arkham city is amazing'))
  test('Rocksteady Studios', () => fail('Rocksteady Studios made great games'))
  test('skanks + skanking (derogatory co-occurrence)', () =>
    fail('Stop calling women skanks, skanking is a dance'))
  test('skanking alone (ska dancing) → PASS', () =>
    pass('Everyone was skanking at the front of the pit!'))
  test('polska', () => fail('Playing polska on the fiddle tonight'))
  test('Slavic feminine surname (Jasińska)', () =>
    fail('An admirable strength. The Nazis wanted to break Alina Jasińska'))
  test('Slavic surname does not block HIGH_CONFIDENCE in same post', () =>
    pass('Alina Jasińska loves #ska'))
})

// ---------------------------------------------------------------------------
// Reply gate: replies only pass HIGH_CONFIDENCE (tested via note — the
// reply gate is enforced in processEvent, not isSkaRelated itself,
// so these test the underlying gate function used for root posts)
// ---------------------------------------------------------------------------

describe('Madness: dash separator / possessive / member names', () => {
  test('Madness - Title (dash breaks flank scan)', () =>
    pass('Madness - "Baggy Trousers" (Live at Glastonbury, 2009)'))
  test('#Madness - Title (hash + dash)', () =>
    pass('#musicsky #skasky Live: #Madness - One Step Beyond Dublin 1979'))
  test('Specials/Madness (slash breaks flank scan)', () =>
    pass('Know a Specials/Madness tribute act that do a lot of touring and festivals'))
  test('Madness\' possessive + song context', () =>
    pass('The first song played after moving in was Madness\' "Our House"'))
  test('Madness\'s possessive', () =>
    pass('If you\'ve only heard Madness\'s version of It Must Be Love, have your life changed'))
  test('Suggs and Lee from Madness (member names skip flank)', () =>
    pass('Suggs and Lee from Madness need to hear this song'))
  test('by Madness (credit line)', () =>
    pass('One Step Beyond by Madness is a classic'))
  test('Madstock', () => pass('listening to the live Madstock album'))
  test('Madness + Specials (2-tone co-occurrence + music context)', () =>
    pass('Madness and the Specials on the same bill — best gig ever'))
  test('#skasky tag', () => pass('amazing night #skasky'))
})

describe('skanking: dance verb vs derogatory noun', () => {
  test('skank (verb) + skanking — dance context, not derogatory', () =>
    pass('the really bad thing about my knee is i can\'t skank. but skanking is what put me in this situation'))
  test('skanks (plural noun) + skanking — derogatory co-occurrence → blocked', () =>
    fail('Stop calling women skanks, skanking is a dance'))
  test('skanking alone → HIGH_CONFIDENCE', () =>
    pass('Everyone was skanking at the front of the pit!'))
})

describe('standalone ska: requires context', () => {
  test('ska + band', () => pass('Listening to some great ska bands'))
  test('ska + gig', () => pass('ska gig tonight!'))
  test('ska alone — no context', () => fail('We ska go to the store'))
  test('two-tone + music context', () => pass('Classic two-tone record in my collection'))
  test('two-tone eye color (Vtuber) → no music context', () =>
    fail(
      'Vtubers show off your eyes! My eye color is just a config setting so they can change with my mood, but this red-/blue-violet two-tone is my favorite. #VtuberEN #vtuber',
    ))
  test('rude boy + show', () => pass('every rude boy at the show'))
})

// ---------------------------------------------------------------------------
// Pioneer Valley Ska Fest — TEMPORARY promotion (remove after the weekend)
// ---------------------------------------------------------------------------

describe('PVSF: hashtags, name, venue (always pass)', () => {
  test('#pvsf', () => pass('so hyped for this weekend #pvsf'))
  test('#pioneervalleyskafest', () => pass('lineup dropped #pioneervalleyskafest'))
  test('#pvska', () => pass('see you all there #pvska'))
  test('#pvskafest', () => pass('#pvskafest tickets on sale now'))
  test('Pioneer Valley Ska Fest', () => pass('Pioneer Valley Ska Fest is this weekend'))
  test('Pioneer Valley Ska Festival', () => pass('heading to the Pioneer Valley Ska Festival'))
  test('Western Mass Ska', () => pass('the Western Mass Ska scene is thriving'))
  test('413 ska', () => pass('413 ska represent'))
  test('#413ska hashtag', () => pass('see you all at #413ska this weekend'))
  test('venue: 52 Sumner St', () => pass('doors open at 52 Sumner St, Springfield MA'))
  test('venue: 52 Sumner (no St)', () => pass('the show is at 52 Sumner tonight'))
  test('venue: #52Sumner hashtag', () => pass('#52Sumner doors at 7pm'))
})

describe('PVSF: lineup bands (always pass, no music context)', () => {
  test('Sgt. Scag', () => pass('Sgt. Scag closing out the night'))
  test('Girth Control', () => pass('Girth Control just went on'))
  test('Skarmy of Darkness', () => pass('Skarmy of Darkness absolutely rips'))
  test('Futon Lasagna', () => pass('cannot wait for Futon Lasagna'))
  test('PWRUP', () => pass('PWRUP bringing the skacore'))
  test('Skaleton Crew', () => pass('Skaleton Crew opening the fest'))
  test('SABON (all-caps band styling)', () => pass('SABON on the main stage'))
  test('sabon soap brand (lowercase) does NOT match', () =>
    fail('bought some sabon hand soap at the store today'))
})

describe('PVSF: common-word bands (music-context gated)', () => {
  test('Pink Slip + ska indicator', () => pass('Pink Slip played a killer ska set'))
  test('Pink Slip + #pvska', () => pass('Pink Slip up next #pvska'))
  test('Pink Slip + music context but no ska indicator → blocked (same-name band, other genre)', () =>
    fail('Pink Slip played a killer show'))
  test('pink slip idiom (no context) → blocked', () =>
    fail('got a pink slip at work today, been laid off'))
  test('The Going Rate + festival lineup', () => pass('The Going Rate on the festival lineup'))
  test('going rate idiom (no context) → blocked', () =>
    fail('the going rate for a plumber is $150 an hour'))
  test('Thumper + show', () => pass('Thumper played a great show'))
  test('Thumper (Bambi, no context) → blocked', () =>
    fail('Thumper is my favorite character in Bambi'))
  test('the selectmen (town govt, no context) → blocked', () =>
    fail('the selectmen voted to approve the town budget'))
})
