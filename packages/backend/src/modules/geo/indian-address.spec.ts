import { placeCandidates, isAddressUsable } from './indian-address';

/**
 * Every address in this file is a real row from the live roster.
 *
 * The bug being pinned down: the whole address string was passed as Nominatim's `street`
 * parameter. Structured search ANDs its components, so a `street` that is not a street name
 * returns nothing — and measured against the live server, dropping the street took a record from
 * 0 hits to 1. The uniform 3 km accuracy across the roster was not the map's limit, it was a query
 * that could not succeed.
 */
describe('placeCandidates — what in an address a map might know', () => {
  const first = (address: string) => placeCandidates(address)[0];

  it('leads with the road, because a road is the most precise thing a map holds here', () => {
    expect(first('S/O: Ranpura Shantilal, B-7, Vrundavan Township, Opp Nageshwar Temple, Harni Road, Vadodara, Gujarat, 390006'))
      .toBe('Harni Road');
    expect(first('House No-3984, Street No-5, Amrik Singh Road, Bathinda-151001')).toBe('Amrik Singh Road');
    expect(first('S/O Padagalingam, 36, Eswaran Kovil Street, Kallidaikkurichi, Tirunelveli, Tamil Nadu-627416'))
      .toBe('Eswaran Kovil Street');
  });

  it('falls to a named neighbourhood when there is no road', () => {
    expect(first('81, Sunaro Ka Bass, Satlana, Jodhpur, Rajasthan-342802')).toBe('Sunaro Ka Bass');
    expect(first('C/O Amar Nath, Aadarsh Colony, Ward No-15, Near Bus Stand, Assandh, Karnal, Haryana-132039'))
      .toBe('Aadarsh Colony');
  });

  /**
   * A person's name is not a place. This is the same confusion that pinned 52 appraisers onto
   * businesses carrying their own name, arriving by a different route.
   */
  it.each([
    ['S/O Blachandran Nair R, Drisya, Veppinmoodu, Poothakkulam, Kollam, Kerala-691302', 'Blachandran'],
    ['C/O Prafulla Kumar Chinira, Patapurpatna, Satapatna, Daspalla, Nayagarh, Odisha-752091', 'Prafulla'],
    ['S/O M.R. Jayaprakash # 155/A, Shivarampet, Devaraja Mohalla,Mysore, Karnataka-570001', 'Jayaprakash'],
  ])('drops the relative named in %s', (address, name) => {
    expect(placeCandidates(address).join(' | ')).not.toMatch(new RegExp(name, 'i'));
  });

  /**
   * A landmark is how a person finds the house, not where it is. Searching for it lands on
   * somebody else's building, which is exactly the false-precision failure this whole exercise
   * is about.
   */
  it.each([
    ['Vasudev 10-A, Amikunj Society, Near GEB Sub Station, Patan Gujarat-384265', /GEB/i],
    ['Arakala Street, Maridamma temple near, Door no -3-3-11/A, Vizianagaram, A.P-535002', /temple/i],
    ['No1 semozhi street, Pelakuppam road,Avaraipakkam,Ajima bakery near Tindivanam,Villupuram district, Tamil Nadu-604001', /bakery/i],
    ['Plot No-3, Siddhivinayak Opp Tapovan School, Kalamba Road, Kolhapur, Near Tapovan School-416012', /Tapovan/i],
  ])('drops the landmark in %s', (address, landmark) => {
    expect(placeCandidates(address).join(' | ')).not.toMatch(landmark);
  });

  /**
   * OSM holds essentially no Indian house numbers, so a door number can only fail to match — and
   * being ANDed, it takes the rest of the query down with it.
   */
  it.each([
    'S/O Vijaya Venkata Suryanarayana, 35-1-3/1, Teeke Street, Manglavarapu, Peta, Rajahmundry, East Godavari, A.P-533101',
    'C/O Muniganti Venkateshwarlu, 4-69/47/B/20, Value Homes, Vidyaranyapuri Road No-3, Theegalaguttapally, Karimnagar, Telangana-505001',
    'House no-12-2-389/70,Zehra Bee Ali Nagar,Murad Nagar,Asif Nagar,Hydrabad-',
    '# 62, Moole devi Thotai, Dharanagiri, Kakkalli, Sirsi, Uttara Kannada, Karnataka-581336',
    'S/O Dhason, 7/55, Koyyal Vilai, Veeyanoor, Kanniyakumari, Veeyannur, Tamil Nadu-629177',
  ])('keeps no house-number fragment from %s', (address) => {
    for (const candidate of placeCandidates(address)) {
      expect(candidate).not.toMatch(/^\s*[\d/\-]+\s*$/);
    }
  });

  it('strips the trailing state-pincode rather than searching for it', () => {
    const candidates = placeCandidates('Gangapur, Dutta Pukur, Barasat-1, North 24 Parganas, West Bengal - 743248');
    expect(candidates.join(' ')).not.toMatch(/743248/);
    expect(candidates[0]).toBe('Gangapur');
  });

  it('unwraps a labelled place rather than searching for the label', () => {
    // "Village- Raghunathpur" must be asked about as Raghunathpur; the label is ours, not the map's.
    expect(placeCandidates('Village- Raghunathpur, PO-Siddhipur, Patna, Bihar-801110'))
      .toEqual(expect.arrayContaining(['Raghunathpur', 'Siddhipur']));
  });

  it('asks about a repeated name once', () => {
    // "Ramapuram" appears twice in this row; a second identical lookup costs a call and returns
    // the same answer.
    const candidates = placeCandidates('S/O P Chandraiah Achari, 1-78 Ramapuram, Pichalur Mandal , Ramapuram A.P-517589');
    const ramapurams = candidates.filter((c) => /ramapuram/i.test(c));
    expect(ramapurams).toHaveLength(1);
  });

  /**
   * An address written with no commas at all — a real row, and the one that exposed the bug.
   *
   * Treating "Near" as grounds to discard the segment threw the whole line away, road and locality
   * with it, and the person was then reported as having no usable address. Splitting on the marker
   * instead keeps both halves, and the road phrase is pulled out of the run it is buried in.
   */
  it('finds the road in a comma-less address that also carries a landmark', () => {
    const candidates = placeCandidates(
      "D-403 Rajhansh Residency Near Shubhash Garden Doctor's Park Road Jahangirpura surat-395009,Landmark-Near Shubhash Garden",
    );
    expect(candidates[0]).toBe("Doctor's Park Road");
    expect(isAddressUsable(
      "D-403 Rajhansh Residency Near Shubhash Garden Doctor's Park Road Jahangirpura surat-395009,Landmark-Near Shubhash Garden",
    )).toBe(true);
  });

  it('pulls a road phrase out of a run rather than searching the whole run', () => {
    // Nominatim matches "Hotgi Road"; it matches nothing for the sentence it sits inside.
    expect(placeCandidates('Revansiddheshwar Nagar Hotgi Road Kumthe Solapur')[0]).toBe('Hotgi Road');
  });

  it('survives an address that is only a name and a number', () => {
    expect(placeCandidates('S/O Rakesh Kumawat, , Kharadi, Maheshwar, Khargone, M.P-451224')[0]).toBe('Kharadi');
  });
});

/**
 * The other half of the promise: when an address genuinely cannot be placed, somebody has to be
 * told, rather than the record quietly taking a pincode centroid and looking finished.
 */
describe('isAddressUsable — is there anything here to look up at all', () => {
  it.each([
    ['81, Sunaro Ka Bass, Satlana, Jodhpur, Rajasthan-342802', true],
    ['Village- Raghunathpur, PO-Siddhipur, Patna, Bihar-801110', true],
    ['', false],
    [null, false],
    ['   ', false],
    // Nothing but a relative's name and a door number: there is no place in this string.
    ['S/O Ramesh Kumar, H.No-110', false],
    ['# 62', false],
    ['123456', false],
  ])('%s → %s', (address, expected) => {
    expect(isAddressUsable(address as any)).toBe(expected);
  });
});
