import styles from './NewBadge.module.css';

/**
 * How many alerts you haven't looked at, wherever that number needs to
 * appear: against a doorbell in the list, on the Activity tab, on the way
 * back to the doorbells you aren't looking at.
 *
 * One component rather than one per site. It had already been written
 * twice - Home's row badge and Activity's "New" heading count - with
 * slightly different type and padding, and a badge you have to read
 * instead of recognise isn't doing its job.
 */
export function NewBadge({ count, context }) {
  // Nothing waiting is the ordinary case, and an empty badge is worse
  // than no badge: it draws the eye in order to say nothing.
  if (!count) return null;

  // Three digits of doorbell presses is a stuck sensor, not a number
  // worth rendering exactly - and it would shove whatever the badge sits
  // beside off the end of the row.
  const shown = count > 99 ? '99+' : String(count);
  const description = `${count} new ${count === 1 ? 'event' : 'events'}${
    context ? ` ${context}` : ''
  }`;

  return (
    <span className={styles.badge} title={description}>
      {/*
        The badge always lives inside something already named - a tab, a
        link to a doorbell - so the description is spelled out here rather
        than as an aria-label, which makes it part of that thing's name:
        "Activity, 3 new events". A bare "3" read aloud says nothing, and
        aria-label on a span with no role is not reliably announced at all.
      */}
      <span aria-hidden="true">{shown}</span>
      <span className={styles.srOnly}>{description}</span>
    </span>
  );
}
