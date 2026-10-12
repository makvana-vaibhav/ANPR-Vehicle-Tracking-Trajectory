#!/usr/bin/env python3
"""Generate the external-registry reference dataset in data/seed/registries/.

The platform cannot reach VAHAN, SARTHI, eGujCop/CCTNS or AFIS/NAFIS, so the
registry adapters (services/api/app/adapters/registries/) answer from a local
dataset instead — and say so in every response. This script writes that
dataset as four CSVs, which `scripts/seed.py` loads:

    vahan.csv        registrations, keyed by plate
    egujcop_firs.csv FIRs that name a plate
    sarthi.csv       driving licences, keyed by licence number
    afis.csv         that a fingerprint record exists, and its reference

## What makes it safe to put on a screen

* **Fictional, and visibly so.** Owners are "Reference Owner 017", licence
  holders "Reference Holder 042", police stations "Reference Police Station
  04", financiers "Reference Financier 03", case numbers start `DEMO/` or
  `REF/`. Addresses are a district and nothing finer.
* **Never on a real vehicle the cameras have seen.** Pass `--avoid` a file of
  every plate read so far (one per line; see below) and every generated plate
  is at least three characters from each of them, so neither an exact nor a
  one- or two-character misread of a real vehicle lands on a fictional
  registration, FIR or blacklist entry. The ten demonstration watchlist plates
  (data/seed/watchlist.csv) are included as they are — they were chosen under
  the same rule — and the script reports their distance again.
* **No biometric data.** The AFIS file holds a reference and nothing else.

## What it covers

All ten watchlist plates, with registration context consistent with each
entry's remark (the stolen cars carry the FIR their case reference names);
a few hundred plausible GJ-series registrations across real Gujarat RTO
codes; and the cases that make the feature worth having: expired insurance,
fitness, PUC and permits, blacklisted and hypothecated vehicles, open and
closed FIRs, a scooter's plate (so a car seen carrying it is a cloned-plate
indicator), suspended, revoked and lapsed licences.

## Regenerating

Export every distinct `detections.plate_normalised` to a file, one per line
(psql's `-At` output is exactly that), then:

    python3 scripts/generate_registry_reference.py --avoid read_plates.txt
    docker compose exec -T api python -m scripts.seed --only registries

Output is deterministic for a given `--seed`, `--as-of` and avoid list.
"""

from __future__ import annotations

import argparse
import csv
import random
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "seed" / "registries"
WATCHLIST_CSV = ROOT / "data" / "seed" / "watchlist.csv"

#: Real Gujarat RTO codes, the district each serves, and its office. The
#: weights lean on Ahmedabad and its neighbours, where the network is.
RTOS: list[tuple[str, str, str, int]] = [
    ("GJ01", "Ahmedabad", "RTO Ahmedabad", 22),
    ("GJ27", "Ahmedabad", "RTO Ahmedabad East (Vastral)", 12),
    ("GJ38", "Ahmedabad", "ARTO Bavla", 3),
    ("GJ18", "Gandhinagar", "RTO Gandhinagar", 8),
    ("GJ05", "Surat", "RTO Surat", 8),
    ("GJ06", "Vadodara", "RTO Vadodara", 7),
    ("GJ03", "Rajkot", "RTO Rajkot", 6),
    ("GJ23", "Anand", "RTO Anand", 4),
    ("GJ07", "Kheda", "RTO Nadiad", 3),
    ("GJ02", "Mehsana", "RTO Mehsana", 3),
    ("GJ04", "Bhavnagar", "RTO Bhavnagar", 3),
    ("GJ09", "Sabarkantha", "RTO Himmatnagar", 2),
    ("GJ10", "Jamnagar", "RTO Jamnagar", 2),
    ("GJ11", "Junagadh", "RTO Junagadh", 2),
    ("GJ12", "Kutch", "RTO Bhuj", 2),
    ("GJ13", "Surendranagar", "RTO Surendranagar", 2),
    ("GJ16", "Bharuch", "RTO Bharuch", 2),
    ("GJ15", "Valsad", "RTO Valsad", 1),
    ("GJ17", "Panchmahal", "RTO Godhra", 1),
    ("GJ21", "Navsari", "RTO Navsari", 1),
    ("GJ24", "Patan", "RTO Patan", 1),
    ("GJ36", "Morbi", "RTO Morbi", 1),
]
RTO_BY_CODE = {code: (district, office) for code, district, office, _ in RTOS}

#: Series letters as issued: I and O are not used, being confusable with 1 and 0.
SERIES = "ABCDEFGHJKLMNPQRSTUVWXYZ"

#: category -> (VAHAN class, weight, [(maker, model, fuel)], [colours])
CATALOGUE: dict[str, tuple[str, int, list[tuple[str, str, str]], list[str]]] = {
    "motorcycle": (
        "M-Cycle/Scooter (2WN)",
        52,
        [
            ("Hero MotoCorp", "Splendor Plus", "Petrol"),
            ("Hero MotoCorp", "HF Deluxe", "Petrol"),
            ("Honda", "Activa 6G", "Petrol"),
            ("Honda", "Shine 125", "Petrol"),
            ("TVS", "Jupiter 110", "Petrol"),
            ("TVS", "Apache RTR 160", "Petrol"),
            ("Bajaj", "Pulsar 150", "Petrol"),
            ("Bajaj", "Platina 100", "Petrol"),
            ("Suzuki", "Access 125", "Petrol"),
            ("Royal Enfield", "Classic 350", "Petrol"),
            ("Ola Electric", "S1 Pro", "Electric"),
            ("Ather", "450X", "Electric"),
        ],
        ["Black", "Red", "Blue", "Grey", "White", "Matte Grey", "Silver", "Maroon"],
    ),
    "car": (
        "Motor Car (LMV)",
        34,
        [
            ("Maruti Suzuki", "Swift VXI", "Petrol"),
            ("Maruti Suzuki", "Baleno Delta", "Petrol"),
            ("Maruti Suzuki", "Wagon R LXI CNG", "Petrol/CNG"),
            ("Maruti Suzuki", "Dzire ZXI", "Petrol"),
            ("Maruti Suzuki", "Ertiga VXI CNG", "Petrol/CNG"),
            ("Maruti Suzuki", "Alto K10", "Petrol"),
            ("Maruti Suzuki", "Brezza ZXI", "Petrol"),
            ("Hyundai", "Creta SX", "Diesel"),
            ("Hyundai", "i20 Asta", "Petrol"),
            ("Hyundai", "Venue S", "Petrol"),
            ("Tata Motors", "Nexon XZ+", "Petrol"),
            ("Tata Motors", "Punch Adventure", "Petrol"),
            ("Tata Motors", "Tiago XZ", "Petrol"),
            ("Tata Motors", "Nexon EV", "Electric"),
            ("Mahindra", "Scorpio-N Z8", "Diesel"),
            ("Mahindra", "XUV700 AX5", "Diesel"),
            ("Mahindra", "Bolero B6", "Diesel"),
            ("Toyota", "Innova Crysta GX", "Diesel"),
            ("Kia", "Seltos HTX", "Petrol"),
            ("Kia", "Sonet HTK", "Petrol"),
            ("Honda", "City VX", "Petrol"),
            ("Honda", "Amaze S", "Petrol"),
        ],
        [
            "White",
            "Pearl White",
            "Silver",
            "Grey",
            "Black",
            "Red",
            "Blue",
            "Brown",
            "Maroon",
        ],
    ),
    "truck": (
        "Goods Carrier (HGV)",
        6,
        [
            ("Tata Motors", "Ace Gold", "Diesel"),
            ("Tata Motors", "LPT 1613", "Diesel"),
            ("Tata Motors", "Signa 4825.TK", "Diesel"),
            ("Ashok Leyland", "Dost+", "Diesel"),
            ("Ashok Leyland", "1920", "Diesel"),
            ("Mahindra", "Bolero Pik-Up", "Diesel"),
            ("Eicher", "Pro 2049", "Diesel"),
        ],
        ["White", "Yellow", "Blue", "Orange", "Silver"],
    ),
    "three_wheeler": (
        "Three Wheeler (Passenger)",
        6,
        [
            ("Bajaj", "RE Compact CNG", "CNG"),
            ("Piaggio", "Ape City CNG", "CNG"),
            ("Mahindra", "Treo", "Electric"),
        ],
        ["Yellow", "Green", "Black"],
    ),
    "bus": (
        "Bus",
        2,
        [
            ("Tata Motors", "Starbus", "Diesel"),
            ("Ashok Leyland", "Lynx", "Diesel"),
            ("Eicher", "Skyline Pro", "Diesel"),
        ],
        ["White", "Yellow", "Blue"],
    ),
}

#: Where the reference police stations sit, by district.
CITY_OF = {
    "Ahmedabad": "Ahmedabad City",
    "Gandhinagar": "Gandhinagar",
    "Surat": "Surat City",
    "Vadodara": "Vadodara City",
    "Rajkot": "Rajkot City",
}

VAHAN_COLUMNS = [
    "plate",
    "owner_name",
    "owner_district",
    "owner_state",
    "registering_authority",
    "registration_status",
    "vehicle_class",
    "vehicle_category",
    "maker",
    "model",
    "colour",
    "fuel",
    "manufacture_year",
    "registered_on",
    "registration_valid_until",
    "fitness_valid_until",
    "insurance_valid_until",
    "puc_valid_until",
    "permit_valid_until",
    "hypothecated",
    "financier",
    "blacklisted",
    "blacklist_reason",
]
FIR_COLUMNS = [
    "fir_number",
    "police_station",
    "district",
    "state",
    "registered_on",
    "sections",
    "status",
    "linked_plate",
    "vehicle_role",
    "summary",
]
SARTHI_COLUMNS = [
    "licence_number",
    "holder_name",
    "holder_district",
    "holder_state",
    "issuing_authority",
    "issued_on",
    "non_transport_valid_until",
    "transport_valid_until",
    "classes",
    "status",
    "status_reason",
]
AFIS_COLUMNS = [
    "reference",
    "afis_reference",
    "nafis_reference",
    "linked_fir_number",
    "district",
    "recorded_on",
]


# ── Edit distance ─────────────────────────────────────────────────────


def within(a: str, b: str, k: int) -> bool:
    """Whether the Levenshtein distance between a and b is at most k."""
    if abs(len(a) - len(b)) > k:
        return False
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            current[j] = min(
                previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)
            )
        if min(current) > k:
            return False
        previous = current
    return previous[-1] <= k


def nearest(plate: str, others: list[str]) -> int:
    """Smallest edit distance from plate to any of others, capped at 3."""
    for k in (0, 1, 2):
        if any(within(plate, other, k) for other in others):
            return k
    return 3


# ── Builders ──────────────────────────────────────────────────────────


@dataclass
class Dataset:
    vahan: list[dict[str, str]]
    firs: list[dict[str, str]]
    sarthi: list[dict[str, str]]
    afis: list[dict[str, str]]


def iso(day: date | None) -> str:
    return day.isoformat() if day else ""


def years_after(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years) - timedelta(days=1)
    except ValueError:  # 29 February
        return day.replace(year=day.year + years, day=28) - timedelta(days=1)


def vehicle(
    *,
    plate: str,
    owner: int,
    district: str,
    office: str,
    category: str,
    maker: str,
    model: str,
    colour: str,
    fuel: str,
    year: int,
    registered_on: date,
    registration_valid_until: date,
    insurance: date | None,
    puc: date | None,
    fitness: date | None = None,
    permit: date | None = None,
    state: str = "Gujarat",
    status: str = "ACTIVE",
    vehicle_class: str | None = None,
    financier: int | None = None,
    blacklist_reason: str | None = None,
) -> dict[str, str]:
    return {
        "plate": plate,
        "owner_name": f"Reference Owner {owner:03d}",
        "owner_district": district,
        "owner_state": state,
        "registering_authority": f"{office} ({plate[:4]})",
        "registration_status": status,
        "vehicle_class": vehicle_class or CATALOGUE[category][0],
        "vehicle_category": category,
        "maker": maker,
        "model": model,
        "colour": colour,
        "fuel": fuel,
        "manufacture_year": str(year),
        "registered_on": iso(registered_on),
        "registration_valid_until": iso(registration_valid_until),
        "fitness_valid_until": iso(fitness),
        "insurance_valid_until": iso(insurance),
        "puc_valid_until": iso(puc),
        "permit_valid_until": iso(permit),
        "hypothecated": "true" if financier else "false",
        "financier": f"Reference Financier {financier:02d}" if financier else "",
        "blacklisted": "true" if blacklist_reason else "false",
        "blacklist_reason": blacklist_reason or "",
    }


def fir(
    number: str,
    station: int,
    city: str,
    district: str,
    registered_on: date,
    sections: list[str],
    status: str,
    plate: str,
    role: str,
    summary: str,
    state: str = "Gujarat",
) -> dict[str, str]:
    return {
        "fir_number": number,
        "police_station": f"Reference Police Station {station:02d}, {city}",
        "district": district,
        "state": state,
        "registered_on": iso(registered_on),
        "sections": "|".join(sections),
        "status": status,
        "linked_plate": plate,
        "vehicle_role": role,
        "summary": f"Reference record — {summary}",
    }


def watchlist_records() -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """The ten demonstration watchlist plates, consistent with their remarks."""
    d = date
    vahan = [
        vehicle(
            plate="GJ03AB1234",
            owner=1,
            district="Rajkot",
            office="RTO Rajkot",
            category="car",
            maker="Hyundai",
            model="Creta SX",
            colour="Polar White",
            fuel="Diesel",
            year=2021,
            registered_on=d(2021, 3, 18),
            registration_valid_until=d(2036, 3, 17),
            insurance=d(2027, 3, 17),
            puc=d(2027, 1, 20),
            financier=4,
        ),
        vehicle(
            plate="GJ01RV4827",
            owner=2,
            district="Ahmedabad",
            office="RTO Ahmedabad",
            category="car",
            maker="Maruti Suzuki",
            model="Swift VXI",
            colour="Solid Fire Red",
            fuel="Petrol",
            year=2019,
            registered_on=d(2019, 7, 2),
            registration_valid_until=d(2034, 7, 1),
            insurance=d(2026, 7, 1),
            puc=d(2026, 10, 30),
        ),
        vehicle(
            plate="MH12DE1433",
            owner=3,
            district="Pune",
            state="Maharashtra",
            office="RTO Pune",
            category="car",
            maker="Mahindra",
            model="Scorpio-N Z8",
            colour="Napoli Black",
            fuel="Diesel",
            year=2023,
            registered_on=d(2023, 1, 11),
            registration_valid_until=d(2038, 1, 10),
            insurance=d(2027, 1, 10),
            puc=d(2026, 12, 2),
            financier=7,
        ),
        vehicle(
            plate="GJ05NR3318",
            owner=4,
            district="Surat",
            office="RTO Surat",
            category="motorcycle",
            maker="Honda",
            model="Activa 6G",
            colour="Pearl Siren Blue",
            fuel="Petrol",
            year=2022,
            registered_on=d(2022, 5, 9),
            registration_valid_until=d(2037, 5, 8),
            insurance=d(2027, 5, 8),
            puc=d(2027, 5, 8),
        ),
        vehicle(
            plate="GJ18W3962",
            owner=5,
            district="Gandhinagar",
            office="RTO Gandhinagar",
            category="motorcycle",
            maker="Bajaj",
            model="Pulsar 150",
            colour="Black",
            fuel="Petrol",
            year=2018,
            registered_on=d(2018, 2, 14),
            registration_valid_until=d(2033, 2, 13),
            insurance=d(2025, 11, 14),
            puc=d(2026, 5, 2),
        ),
        vehicle(
            plate="GJ23CK5190",
            owner=6,
            district="Anand",
            office="RTO Anand",
            category="car",
            maker="Tata Motors",
            model="Nexon XZ+",
            colour="Daytona Grey",
            fuel="Diesel",
            year=2020,
            registered_on=d(2020, 10, 26),
            registration_valid_until=d(2035, 10, 25),
            insurance=d(2026, 10, 25),
            puc=d(2027, 4, 2),
            financier=2,
        ),
        vehicle(
            plate="GJ06KM2219",
            owner=7,
            district="Vadodara",
            office="RTO Vadodara",
            category="truck",
            maker="Tata Motors",
            model="LPT 1613",
            colour="Yellow",
            fuel="Diesel",
            year=2012,
            registered_on=d(2012, 6, 30),
            registration_valid_until=d(2027, 6, 29),
            fitness=d(2025, 8, 9),
            insurance=d(2026, 2, 28),
            puc=d(2025, 12, 1),
            permit=d(2027, 5, 31),
            status="SUSPENDED",
            financier=9,
            blacklist_reason=(
                "Blacklisted by RTO Vadodara: road tax unpaid since April 2025, and the "
                "fitness certificate has lapsed."
            ),
        ),
        vehicle(
            plate="GJ05GY0433",
            owner=8,
            district="Surat",
            office="RTO Surat",
            category="car",
            maker="Maruti Suzuki",
            model="Ertiga VXI CNG",
            colour="Magma Grey",
            fuel="Petrol/CNG",
            year=2021,
            registered_on=d(2021, 8, 17),
            registration_valid_until=d(2036, 8, 16),
            insurance=d(2027, 8, 16),
            puc=d(2027, 2, 16),
        ),
        vehicle(
            plate="GJ27DQ6604",
            owner=9,
            district="Ahmedabad",
            office="RTO Ahmedabad East (Vastral)",
            category="car",
            maker="Honda",
            model="City VX",
            colour="Golden Brown",
            fuel="Petrol",
            year=2017,
            registered_on=d(2017, 11, 3),
            registration_valid_until=d(2032, 11, 2),
            insurance=d(2026, 11, 2),
            puc=d(2026, 8, 15),
        ),
        vehicle(
            plate="GJ01XY7788",
            owner=10,
            district="Ahmedabad",
            office="RTO Ahmedabad",
            category="car",
            vehicle_class="Motor Cab (LMV-TR)",
            maker="Toyota",
            model="Innova Crysta GX",
            colour="Super White",
            fuel="Diesel",
            year=2018,
            registered_on=d(2018, 1, 22),
            registration_valid_until=d(2033, 1, 21),
            fitness=d(2026, 12, 20),
            insurance=d(2027, 1, 21),
            puc=d(2027, 1, 21),
            permit=d(2025, 12, 31),
        ),
    ]
    firs = [
        fir(
            "DEMO/FIR/2026/RJT/0412",
            4,
            "Rajkot City",
            "Rajkot",
            d(2026, 9, 28),
            ["BNS 303(2)"],
            "under_investigation",
            "GJ03AB1234",
            "stolen",
            "four-wheeler reported stolen from a residential street off Kalawad Road.",
        ),
        fir(
            "DEMO/FIR/2026/AHM/0957",
            11,
            "Ahmedabad City",
            "Ahmedabad",
            d(2026, 10, 3),
            ["BNS 303(2)"],
            "under_investigation",
            "GJ01RV4827",
            "stolen",
            "car reported stolen from a parking lot near Navrangpura.",
        ),
        fir(
            "DEMO/FIR/2026/PUNE/0388",
            2,
            "Pune City",
            "Pune",
            d(2026, 8, 19),
            ["BNS 303(2)"],
            "under_investigation",
            "MH12DE1433",
            "stolen",
            "out-of-state theft, circulated to Gujarat through CCTNS inter-state alerts.",
            state="Maharashtra",
        ),
        fir(
            "DEMO/FIR/2026/SRT/0764",
            7,
            "Surat City",
            "Surat",
            d(2026, 9, 12),
            ["BNS 303(2)"],
            "under_investigation",
            "GJ05NR3318",
            "stolen",
            "two-wheeler reported stolen from outside a shop in Udhna.",
        ),
        fir(
            "DEMO/FIR/2026/GNR/1187",
            3,
            "Gandhinagar",
            "Gandhinagar",
            d(2026, 9, 30),
            ["BNS 304(2)"],
            "under_investigation",
            "GJ18W3962",
            "used_in_offence",
            "two-wheeler named by a witness to a chain snatching.",
        ),
        fir(
            "DEMO/FIR/2026/AND/0219",
            1,
            "Anand",
            "Anand",
            d(2026, 7, 6),
            ["BNS 106(2)", "BNS 281", "MV Act 134"],
            "under_investigation",
            "GJ23CK5190",
            "accident",
            "hit-and-run; driver not yet identified.",
        ),
    ]
    return vahan, firs


def generated(
    rng: random.Random, avoid: list[str], taken: set[str], as_of: date, count: int
) -> Dataset:
    vahan: list[dict[str, str]] = []
    firs: list[dict[str, str]] = []
    sarthi: list[dict[str, str]] = []
    afis: list[dict[str, str]] = []

    rto_codes = [r[0] for r in RTOS]
    rto_weights = [r[3] for r in RTOS]
    categories = list(CATALOGUE)
    category_weights = [CATALOGUE[c][1] for c in categories]

    def new_plate() -> str:
        while True:
            code = rng.choices(rto_codes, rto_weights)[0]
            series = "".join(
                rng.choice(SERIES) for _ in range(rng.choice((1, 2, 2, 2)))
            )
            plate = f"{code}{series}{rng.randint(1, 9999):04d}"
            if plate in taken:
                continue
            # The rule that keeps a fictional record off a real vehicle.
            if any(within(plate, other, 2) for other in avoid):
                continue
            taken.add(plate)
            return plate

    owner = 11
    financier_ids = list(range(1, 13))
    blacklist_reasons = [
        "Blacklisted by the RTO: road tax unpaid for over a year.",
        "Blacklisted by the RTO: e-challans unpaid past the notice period.",
        "Blacklisted by the RTO: transfer of ownership not reported within 30 days.",
    ]
    for _ in range(count):
        plate = new_plate()
        district, office = RTO_BY_CODE[plate[:4]]
        category = rng.choices(categories, category_weights)[0]
        vahan_class, _, models, colours = CATALOGUE[category]
        maker, model, fuel = rng.choice(models)
        registered = as_of - timedelta(days=rng.randint(60, 17 * 365))
        transport = category in ("truck", "bus", "three_wheeler")
        reg_until = years_after(registered, 15)
        if reg_until < as_of and rng.random() < 0.6:
            reg_until = years_after(reg_until + timedelta(days=1), 5)  # renewed
        # Insurance renews yearly on the registration anniversary; about one
        # in eight has lapsed.
        insurance: date | None = years_after(registered, as_of.year - registered.year)
        if insurance is not None and insurance < as_of:
            insurance = years_after(registered, as_of.year - registered.year + 1)
        if rng.random() < 0.12:
            insurance = (insurance or as_of) - timedelta(days=365 + rng.randint(0, 120))
        elif rng.random() < 0.03:
            insurance = None
        electric = fuel == "Electric"
        puc = None if electric else as_of + timedelta(days=rng.randint(-150, 360))
        fitness = as_of + timedelta(days=rng.randint(-200, 700)) if transport else None
        permit = as_of + timedelta(days=rng.randint(-120, 1800)) if transport else None
        financed = category in ("car", "truck", "bus") and rng.random() < 0.3
        blacklist = rng.choice(blacklist_reasons) if rng.random() < 0.015 else None
        vahan.append(
            vehicle(
                plate=plate,
                owner=owner,
                district=district,
                office=office,
                category=category,
                vehicle_class=vahan_class,
                maker=maker,
                model=model,
                colour=rng.choice(colours),
                fuel=fuel,
                year=registered.year if registered.month > 3 else registered.year - 1,
                registered_on=registered,
                registration_valid_until=reg_until,
                insurance=insurance,
                puc=puc,
                fitness=fitness,
                permit=permit,
                status="SUSPENDED" if blacklist else "ACTIVE",
                financier=rng.choice(financier_ids) if financed else None,
                blacklist_reason=blacklist,
            )
        )
        owner += 1

    # FIRs on a handful of generated plates: open and closed, theft and offence.
    fir_templates = [
        ("stolen", ["BNS 303(2)"], "vehicle reported stolen by its owner."),
        (
            "stolen",
            ["BNS 303(2)", "BNS 317(2)"],
            "vehicle stolen; parts recovered later.",
        ),
        ("used_in_offence", ["BNS 309(4)"], "vehicle named in a robbery complaint."),
        ("accident", ["BNS 281", "BNS 125(a)"], "rash driving causing hurt."),
        (
            "used_in_offence",
            ["BNS 318(4)", "BNS 336(3)"],
            "vehicle sold on forged papers.",
        ),
    ]
    statuses = ["under_investigation", "chargesheeted", "closed", "vehicle_recovered"]
    linked = rng.sample(vahan, k=14)
    for n, record in enumerate(linked, start=1):
        role, sections, summary = rng.choice(fir_templates)
        status = statuses[n % len(statuses)]
        if role != "stolen" and status == "vehicle_recovered":
            status = "closed"
        district = record["owner_district"]
        city = CITY_OF.get(district, district)
        registered_on = as_of - timedelta(days=rng.randint(20, 900))
        firs.append(
            fir(
                f"REF/FIR/{registered_on.year}/{record['plate'][:4]}/{n:04d}",
                rng.randint(1, 30),
                city,
                district,
                registered_on,
                sections,
                status,
                record["plate"],
                role,
                summary,
            )
        )

    # SARTHI: licences across the same districts.
    class_mixes = [
        (["MCWG"], 30),
        (["MCWG", "LMV"], 48),
        (["LMV"], 10),
        (["MCWG", "LMV", "LMV-TR"], 5),
        (["LMV", "TRANS"], 5),
        (["3W-TR"], 2),
    ]
    holder = 7
    numbers = {lic["licence_number"] for lic in curated_licences()}
    for _ in range(140):
        code = rng.choices(rto_codes, rto_weights)[0]
        district, office = RTO_BY_CODE[code]
        issued = as_of - timedelta(days=rng.randint(30, 30 * 365))
        number = f"{code}{issued.year}{rng.randint(1, 99999):07d}"
        if number in numbers:
            continue
        numbers.add(number)
        classes = rng.choices([m for m, _ in class_mixes], [w for _, w in class_mixes])[
            0
        ]
        transport_held = any(c in ("LMV-TR", "TRANS", "3W-TR") for c in classes)
        non_transport = years_after(issued, 20)
        if non_transport < as_of and rng.random() < 0.7:
            non_transport = years_after(non_transport + timedelta(days=1), 10)
        transport = (
            as_of + timedelta(days=rng.randint(-300, 1500)) if transport_held else None
        )
        status, reason = "active", ""
        roll = rng.random()
        if roll < 0.025:
            status = "suspended"
            reason = (
                "Suspended for six months by the licensing authority under MV Act 19."
            )
        elif roll < 0.035:
            status = "revoked"
            reason = "Revoked by the licensing authority."
        sarthi.append(
            {
                "licence_number": number,
                "holder_name": f"Reference Holder {holder:03d}",
                "holder_district": district,
                "holder_state": "Gujarat",
                "issuing_authority": f"{office} ({code})",
                "issued_on": iso(issued),
                "non_transport_valid_until": iso(
                    None if classes == ["3W-TR"] else non_transport
                ),
                "transport_valid_until": iso(transport),
                "classes": "|".join(classes),
                "status": status,
                "status_reason": reason,
            }
        )
        holder += 1

    # AFIS: records filed against a few of the generated FIRs.
    for n, record in enumerate(firs[:5], start=1):
        afis.append(
            {
                "reference": record["fir_number"],
                "afis_reference": f"REF-AFIS-GJ-{record['registered_on'][:4]}-{n:06d}",
                "nafis_reference": (
                    f"REF-NAFIS-{record['registered_on'][:4]}-{n:07d}" if n % 2 else ""
                ),
                "linked_fir_number": record["fir_number"],
                "district": record["district"],
                "recorded_on": iso(
                    date.fromisoformat(record["registered_on"]) + timedelta(days=3)
                ),
            }
        )
    return Dataset(vahan, firs, sarthi, afis)


def curated_licences() -> list[dict[str, str]]:
    """Six licences chosen to show each state the card can be in."""

    def lic(
        number: str,
        holder: int,
        code: str,
        issued: date,
        non_transport: date | None,
        transport: date | None,
        classes: list[str],
        status: str = "active",
        reason: str = "",
    ) -> dict[str, str]:
        district, office = RTO_BY_CODE[code]
        return {
            "licence_number": number,
            "holder_name": f"Reference Holder {holder:03d}",
            "holder_district": district,
            "holder_state": "Gujarat",
            "issuing_authority": f"{office} ({code})",
            "issued_on": iso(issued),
            "non_transport_valid_until": iso(non_transport),
            "transport_valid_until": iso(transport),
            "classes": "|".join(classes),
            "status": status,
            "status_reason": reason,
        }

    d = date
    return [
        lic(
            "GJ0120190004217",
            1,
            "GJ01",
            d(2019, 4, 2),
            d(2039, 4, 1),
            None,
            ["MCWG", "LMV"],
        ),
        lic(
            "GJ0520120018830",
            2,
            "GJ05",
            d(2012, 9, 14),
            d(2032, 9, 13),
            None,
            ["MCWG", "LMV"],
            status="suspended",
            reason=(
                "Suspended for six months by RTO Surat under MV Act 19 after a "
                "drunken-driving conviction."
            ),
        ),
        lic(
            "GJ1820060007712",
            3,
            "GJ18",
            d(2006, 3, 2),
            d(2026, 3, 1),
            None,
            ["MCWG", "LMV"],
        ),
        lic(
            "GJ0620160021904",
            4,
            "GJ06",
            d(2016, 7, 1),
            d(2036, 6, 30),
            d(2026, 6, 30),
            ["LMV", "TRANS"],
        ),
        lic(
            "GJ0320210009981",
            5,
            "GJ03",
            d(2021, 12, 6),
            d(2041, 12, 5),
            None,
            ["MCWG"],
        ),
        lic(
            "GJ2320000003318",
            6,
            "GJ23",
            d(2000, 5, 19),
            d(2030, 5, 18),
            None,
            ["MCWG", "LMV"],
            status="revoked",
            reason="Revoked by RTO Anand after a fatal hit-and-run conviction.",
        ),
    ]


def curated_afis() -> list[dict[str, str]]:
    """Records against the demonstration cases, and two person references."""
    return [
        {
            "reference": "DEMO/FIR/2026/RJT/0412",
            "afis_reference": "REF-AFIS-GJ-2026-004120",
            "nafis_reference": "",
            "linked_fir_number": "DEMO/FIR/2026/RJT/0412",
            "district": "Rajkot",
            "recorded_on": "2026-09-30",
        },
        {
            "reference": "DEMO/FIR/2026/GNR/1187",
            "afis_reference": "REF-AFIS-GJ-2026-011870",
            "nafis_reference": "REF-NAFIS-2026-0000877",
            "linked_fir_number": "DEMO/FIR/2026/GNR/1187",
            "district": "Gandhinagar",
            "recorded_on": "2026-10-02",
        },
        {
            "reference": "DEMO/PER/2026/0004",
            "afis_reference": "REF-AFIS-GJ-2026-011871",
            "nafis_reference": "REF-NAFIS-2026-0000878",
            "linked_fir_number": "DEMO/FIR/2026/GNR/1187",
            "district": "Gandhinagar",
            "recorded_on": "2026-10-04",
        },
        {
            "reference": "DEMO/PER/2026/0009",
            "afis_reference": "REF-AFIS-GJ-2025-008812",
            "nafis_reference": "REF-NAFIS-2025-0004410",
            "linked_fir_number": "",
            "district": "Ahmedabad",
            "recorded_on": "2025-12-11",
        },
    ]


def write(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"  {path.relative_to(ROOT)}: {len(rows)} rows")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--avoid", type=Path, help="plates read so far, one per line")
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    parser.add_argument("--seed", type=int, default=20261012)
    parser.add_argument("--as-of", type=date.fromisoformat, default=date(2026, 10, 12))
    parser.add_argument(
        "--count", type=int, default=320, help="generated registrations"
    )
    args = parser.parse_args()

    avoid: list[str] = []
    if args.avoid:
        avoid = sorted(
            {
                "".join(ch for ch in line.upper() if ch.isalnum())
                for line in args.avoid.read_text(encoding="utf-8").splitlines()
                if line.strip()
            }
        )
    print(f"Avoiding {len(avoid)} plates read by the cameras")

    watch_vahan, watch_firs = watchlist_records()
    watch_plates = [r["plate"] for r in watch_vahan]
    with WATCHLIST_CSV.open(encoding="utf-8") as handle:
        listed = {row["plate"] for row in csv.DictReader(handle)}
    missing = listed - set(watch_plates)
    if missing:
        raise SystemExit(
            f"watchlist plates without a reference record: {sorted(missing)}"
        )
    for plate in watch_plates:
        distance = nearest(plate, avoid)
        if distance < 3:
            print(
                f"  WARNING {plate} is {distance} edit(s) from a plate the cameras read"
            )

    rng = random.Random(args.seed)
    data = generated(rng, avoid, set(watch_plates), args.as_of, args.count)

    args.out.mkdir(parents=True, exist_ok=True)
    write(args.out / "vahan.csv", VAHAN_COLUMNS, watch_vahan + data.vahan)
    write(args.out / "egujcop_firs.csv", FIR_COLUMNS, watch_firs + data.firs)
    write(args.out / "sarthi.csv", SARTHI_COLUMNS, curated_licences() + data.sarthi)
    write(args.out / "afis.csv", AFIS_COLUMNS, curated_afis() + data.afis)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
