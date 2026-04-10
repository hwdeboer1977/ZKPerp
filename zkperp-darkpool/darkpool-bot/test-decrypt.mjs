import { Account } from '@provablehq/sdk'

const VK = 'AViewKey1is8iPit9ftsVVkxPe5AAXWbSXbTWCkPRVZZ7v1PAjBFE'
const a = new Account({ viewKey: VK })
console.log('address:', a.address().to_string())

const records = [
  'record1qvqspmcwu4xs22rjj48cstg4ajz0kuefpcychhvya39rydr40ltv76s8quyxzumnv46976tyyvqqyqgqgsfpr990s3zevxavycf9msg3dh7qrfwcdj2rae95sg0n93qtl5qsjerfwfjkxarfdahzxqqzqyq87p6j0w7eg4gmzjrrfqxzjc9x3mffceayl47gycl0r3p364cxurqywd5h5efrqqpqzq9pkfqmpxkgmp5z74c2td3jpzr5t9r8vs8hksdfu0jzr695auvvq59kc6tdd9697urjd93k2gcqqgqspuaf5tq8w3v7jsnupdlxdecqn0f38sknrjrh5vk2wpwyj8z5yfg0q3ekzmr5gvqqyqsqqc5w0pvus30n8h7ztx4fz44hz977k48t2dnsf43wu79c3t27lgy8ezft20a4y3n5gq82r8mm6uy2xhd8qpg0q4e6x7klrtsl980y2zsxv4u8q6tj0y3sqqspqz597z22rc64ewdk2th3745uu9apu6xne8zqlqqzp2ku8evjyw2qjptwdahxxe2rqqpqyq9d7yd8pasnrhnhswwxfwn64g86688d83dkdywc39ygat2prnp3z9yqsct5z69d54m87jswmknlxu3jf2jx8mzn20nxugh3cqnec5fskwna4u60qvxqgf5kz8efqmnep3sq25c4vt209cg3e6mjpyz3sccxlh9hcl',
  'record1qvqsp8r2nc00fq7rwzehqfu7kfp42y04xxz0gr43gmusfzzuacf0zdswq5z82um9wfpsqqszqrsus2zchu9tkkx59my24kx3vmvvc0fgrx7x9ctr06dj742k0sg39l5wqwcpn944wcw6t9cuvk7f0hdfy8vuraulwus3lyxk2x9hr9gvpdhhyer9wf0kummwvdj5xqqzqgq8z6wm92lcgqjg9szs86lp08mcemc3ug40dsr8e8sypcal90ew7zc8h455qyhr5cxvvwf6ny47zczmwhwwh5nglh9n5y2a2r2hy8w3pvyxzumnv46976tyyvqqyqgqk6qy96g0l42ykhrd5xe7aux88eww29yzdlzqx25lt5rus5haz5xsjerfwfjkxarfdahzxqqzqyqwlx6k2hf26wutjg8ual9uzey29grly445e00xxt94mtm6g0pkuzgxv4u8q6tj0y3sqqspqr0nv3awexthk9jzdsr80cwlvzfuc9rrfpaax9vr2vhva984szks9q50jw8md44xqry36z5a9g7q3ayfegjt0v2qp3gyfpy0encfh5g0mpff9r'
]

for (const [i, ct] of records.entries()) {
  console.log(`\n--- record[${i}] ---`)
  try {
    const owned = a.ownsRecordCiphertext(ct)
    console.log('ownsRecordCiphertext:', owned)
    if (owned) {
      const r = a.decryptRecords([ct])
      console.log('decrypted:', r)
    }
  } catch(e) { console.log('error:', String(e).slice(0,120)) }
}
