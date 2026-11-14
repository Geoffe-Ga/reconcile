/**
 * The strange-bedfellows spike's sample writing (#428): invented readers and
 * invented shelf entries, written for this purpose. Every group, person and
 * place here is made up, and none stands for a real one.
 *
 * Each reader is a person's own personal Documents and the Documents of
 * their groups, as the device holds them. Each entry is a shelf Dispatch:
 * a title, up to 500 characters of text, and the names of the levels that
 * published it (ADR-0077 §1).
 *
 * `kin` says, by a person's reading and before any method ran, how much an
 * entry shares with each reader. A reader it leaves out shares nothing.
 * - `near`: it says what the reader already says, nearly word for word.
 * - `one`: it shares one thing with the reader and differs on the rest:
 *   a strange bedfellow, which the default band must surface.
 * - `unseen`: it shares one thing, but in other words, which a term method
 *   can't see; the tests hold that it falls below the band.
 * - `opposed`: it shares a subject and takes the other side, which a term
 *   method can't tell from agreement; the tests hold that it lands in the band.
 * - `passing`: it shares one thing, but only in passing, two words in one
 *   clause of an entry about something else. The coal plant pair was first
 *   marked `one`; on these samples no band takes it in without also taking a
 *   coincidence ("boards, winter"), so it stands apart for the founder to
 *   weigh, and the tests hold that the default band leaves it out.
 */
import type { KinshipText } from '../discover/kinship';

/** How much an entry shares with a reader, by a person's reading. */
export type SampleKin = 'near' | 'one' | 'unseen' | 'opposed' | 'passing';

/** A sample reader: what their device would compare entries with. */
export interface SampleReader {
  readonly id: string;
  /** Who they are, in a few words, for the comparison table. */
  readonly about: string;
  readonly documents: readonly KinshipText[];
}

/** A sample shelf entry. */
export interface SampleEntry extends KinshipText {
  readonly id: string;
  /** The levels that published it: shown beside it, never scored. */
  readonly levels: readonly string[];
  /** How much it shares with each reader it shares anything with. */
  readonly kin: Readonly<Record<string, SampleKin>>;
}

/** Four readers far apart from each other. */
export const SAMPLE_READERS: readonly SampleReader[] = [
  {
    id: 'wren',
    about: 'low taxes, church, homeschool, and the public library',
    documents: [
      {
        title: 'What I stand for',
        text: 'I believe in low taxes and a county government that lives within its means. Parents, not officials, should decide how their children are taught, and we homeschool our three. Our church runs a food pantry every Saturday morning. Every new levy has to earn its keep. The one public service I will always defend is the Wrenfield public library: it gives families a quiet place to read, borrow books and learn, and it costs little for what it gives back.',
      },
      {
        title: 'Wrenfield Taxpayers Circle: our aims',
        text: 'We read the county budget line by line and publish what we find. We oppose the new sales tax levy and the stadium bond. We ask for spending cuts before any tax rise, open books on every county contract, and term limits for the county board.',
      },
    ],
  },
  {
    id: 'ash',
    about: 'tenants, late buses, unions, and closing the coal plant',
    documents: [
      {
        title: 'Why I organize',
        text: 'I organize with tenants for fair rent and safe homes. I want buses that run late into the night, a living wage, and a union in every warehouse. Climate change is the fight of our time: the coal plant on the ridge has to close, and the money should go to the workers who lose their jobs.',
      },
      {
        title: 'Eastside Tenants Union: platform',
        text: 'Rent stabilization for every unit. Repairs within thirty days. No evictions in winter. A tenant seat on the housing board, elected by tenants.',
      },
    ],
  },
  {
    id: 'pell',
    about: 'deer season, rifles, his land, and a sick river',
    documents: [
      {
        title: 'My land and my river',
        text: 'I hunt deer every November and fish the Okker River with my sons. Owning a rifle is a right I will defend. Keep the state off my land and out of my business. The river has been sick for years from the feedlot runoff upstream, and the trout are gone from the lower bend.',
      },
    ],
  },
  {
    id: 'sol',
    about: 'privacy, teaching kids to code, and no war',
    documents: [
      {
        title: 'Notes on what matters to me',
        text: 'I write software for a living and I care about privacy. No company and no school should track children online or sell what they learn about them. I teach coding at the youth center on Thursdays. I oppose war, and I will march against any draft.',
      },
      {
        title: 'Thursday Coders: what we do',
        text: 'We teach young people to build websites, games and small robots. Every laptop is donated and wiped. Every lesson is free.',
      },
    ],
  },
];

/** Shelf entries: strange bedfellows, near copies, the unrelated, and the method's blind spots. */
export const SAMPLE_ENTRIES: readonly SampleEntry[] = [
  {
    id: 'branch-library',
    title: 'Keep the Eastside branch library open',
    text: 'The council plans to close the Eastside branch library to balance its budget. Our circle has met there every week for nine years. Working families need free books, quiet rooms and computers that someone else paid for. Come to the council meeting on Tuesday and say it plainly: the public library stays open.',
    levels: ['Eastside Socialist Reading Circle'],
    kin: { wren: 'one' },
  },
  {
    id: 'spending-cuts',
    title: 'Spending cuts before any tax rise',
    text: 'We read the county budget line by line and publish what we find. We oppose the new sales tax levy and the stadium bond. Cut spending before any tax rise, open the books on every county contract, and set term limits for the county board.',
    levels: ['Wrenfield Taxpayers Circle'],
    kin: { wren: 'near' },
  },
  {
    id: 'clean-river',
    title: 'Clean the Okker River',
    text: "Feedlot runoff has poisoned the Okker River for a decade. The trout are gone and the algae blooms every summer. We want the state to enforce the clean water rules upstream, and we want the coal plant's ash ponds lined before they leak. Join our river cleanup on Saturday.",
    levels: ['Okker Valley Climate Action'],
    kin: { pell: 'one', ash: 'passing' },
  },
  {
    id: 'rod-and-gun',
    title: 'Hunters for the Okker',
    text: 'We hunt deer every November and fish the Okker River with our children. Owning a rifle is a right we will defend. Keep the state off our land and out of our business. The river has been sick for years from feedlot runoff upstream, and the trout are gone from the lower bend.',
    levels: ['Okker Rod and Gun Club'],
    kin: { pell: 'near' },
  },
  {
    id: 'no-tracking',
    title: 'No tracking apps in our schools',
    text: 'The school board wants every child to install a monitoring app that logs where they go and what they read. We are parents of faith and we say no. Our children are not data for a company to sell. We will pray for the board, and we will vote them out in the spring.',
    levels: ['Hearth and Home Parents Fellowship'],
    kin: { sol: 'one', wren: 'one' },
  },
  {
    id: 'draft-bill',
    title: 'Stop the draft bill',
    text: 'A bill in the capital would bring back the draft for everyone over eighteen. We have opposed war for three generations, and we will not send our grandchildren to fight one. March with us on the first of the month, and write to your representative today.',
    levels: ['Meadowbrook Peace Fellowship'],
    kin: { sol: 'one' },
  },
  {
    id: 'late-buses',
    title: 'Late buses for night-shift staff',
    text: 'Our shops close at ten, and our staff wait an hour for a bus home. We ask the transit authority to run buses late into the night on the Northgate line. Late buses mean safer streets, more customers, and staff who arrive on time.',
    levels: ['Northgate Small Business Association'],
    kin: { ash: 'one' },
  },
  {
    id: 'stairwell',
    title: 'Rent stabilization for every unit',
    text: 'Rent stabilization for every unit. Repairs within thirty days. No evictions in winter. A tenant seat on the housing board, elected by tenants. Come to the meeting on Monday.',
    levels: ['Eastside Tenants Union'],
    kin: { ash: 'near' },
  },
  {
    id: 'old-laptops',
    title: 'Wipe an old laptop, teach a kid',
    text: 'Donate the laptop in your closet. We wipe every drive, install free software, and give it to a young person learning to code. We have no politics; we just like fixing things.',
    levels: ['Northgate Retired Engineers'],
    kin: { sol: 'one' },
  },
  {
    id: 'chess',
    title: 'Chess in the park',
    text: 'Boards are set up by the fountain every Sunday from noon. Bring a clock if you have one. Beginners play the first hour for free, and the winter league starts in January.',
    levels: ['Wrenfield Chess Club'],
    kin: {},
  },
  {
    id: 'choir',
    title: 'Spring choir concert',
    text: 'Forty voices, one evening. We sing hymns, folk songs and a new piece written by our youngest singer. Tickets are pay what you can, and the hall has a ramp.',
    levels: ['Alder Hall Choir'],
    kin: {},
  },
  {
    id: 'potholes',
    title: 'Report a pothole',
    text: 'Snap a photo, drop a pin, and we will chase the roads department until it is filled. Last month we logged sixty holes on Mill Road alone.',
    levels: ['Mill Road Neighbors'],
    kin: {},
  },
  {
    id: 'reading-room',
    title: "Don't shutter the Elm Street reading room",
    text: 'The town wants to shutter the reading room on Elm Street. Neighbors take home novels there, kids do homework there, and nobody pays a cent. Tell the aldermen to leave it be.',
    levels: ['Elm Street Mutual Aid'],
    kin: { wren: 'unseen' },
  },
  {
    id: 'deer-refuge',
    title: 'Let the deer winter in peace',
    text: 'Every November the woods fill with rifles. We ask the state to end the deer season in the lower valley and to set the land aside as a refuge. No animal should die for a trophy.',
    levels: ['Okker Valley Animal Rights'],
    kin: { pell: 'opposed' },
  },
];
