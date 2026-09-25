from __future__ import annotations

import copy
import io
import re
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Iterable

from lxml import etree

D2L_NS = "http://desire2learn.com/xsd/d2lcp_v2p0"
IMSCP_NS = "http://www.imsglobal.org/xsd/imscp_v1p1"
OUTPUT_NAME = "Brightspace_QuestionLibrary_Migration.zip"

QUESTION_COUNT_TAGS = (
    "presentation",
    "resprocessing",
    "hint",
    "itemfeedback",
    "response_lid",
    "response_str",
    "response_num",
    "response_label",
    "respcondition",
    "varequal",
    "setvar",
)

LOCAL_REF_RE = re.compile(
    r"""\b(?:src|href)\s*=\s*["']([^"']+)["']""",
    flags=re.IGNORECASE,
)


class ConversionError(RuntimeError):
    """Raised when source analysis, conversion, or validation fails."""


@dataclass(slots=True)
class Question:
    node: etree._Element
    question_type: str
    fingerprint: dict
    references: list[str]


@dataclass(slots=True)
class Assessment:
    source_name: str
    title: str
    questions: list[Question]


@dataclass(slots=True)
class ConversionResult:
    package_bytes: bytes
    report: list[dict]
    warnings: list[str]


def _xml_parser() -> etree.XMLParser:
    return etree.XMLParser(
        remove_blank_text=False,
        recover=False,
        resolve_entities=False,
        no_network=True,
        huge_tree=True,
    )


def _parse_xml(data: bytes | str, source_name: str) -> etree._Element:
    try:
        if isinstance(data, str):
            data = data.encode("utf-8")
        return etree.fromstring(data, parser=_xml_parser())
    except (etree.XMLSyntaxError, ValueError) as exc:
        raise ConversionError(f"{source_name}: invalid XML ({exc}).") from exc


def _local_name(node: etree._Element) -> str:
    try:
        return etree.QName(node).localname
    except ValueError:
        return ""


def _descendants(root: etree._Element, local_name: str) -> list[etree._Element]:
    return [
        node
        for node in root.iter()
        if isinstance(node.tag, str) and _local_name(node) == local_name
    ]


def _direct_children(root: etree._Element, local_name: str) -> list[etree._Element]:
    return [
        node
        for node in root
        if isinstance(node.tag, str) and _local_name(node) == local_name
    ]


def _first_descendant(
    root: etree._Element,
    local_name: str,
) -> etree._Element | None:
    return next(iter(_descendants(root, local_name)), None)


def _direct_child(
    root: etree._Element,
    local_name: str,
) -> etree._Element | None:
    return next(iter(_direct_children(root, local_name)), None)


def _normalize_path(value: str) -> str:
    value = (value or "").replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return value.lstrip("/")


def _basename(value: str) -> str:
    return PurePosixPath(_normalize_path(value)).name


def _find_name(names: Iterable[str], requested: str) -> str | None:
    normalized = _normalize_path(requested)
    candidates = list(names)

    for name in candidates:
        if _normalize_path(name) == normalized:
            return name

    base = _basename(normalized)
    matches = [name for name in candidates if _basename(name) == base]
    return matches[0] if len(matches) == 1 else None


def _manifest_selfassessment_hrefs(manifest_root: etree._Element) -> list[str]:
    hrefs: list[str] = []
    for resource in _descendants(manifest_root, "resource"):
        material_type = (
            resource.get(f"{{{D2L_NS}}}material_type")
            or resource.get("d2l_2p0:material_type")
        )
        href = resource.get("href")
        if material_type == "d2lselfassess" and href:
            hrefs.append(_normalize_path(href))
    return hrefs


def _parse_assessment(xml_bytes: bytes, source_name: str) -> Assessment:
    root = _parse_xml(xml_bytes, source_name)
    assessment = (
        root if _local_name(root) == "assessment"
        else _first_descendant(root, "assessment")
    )
    if assessment is None:
        raise ConversionError(
            f"{source_name}: no <assessment> element was found."
        )

    title = assessment.get("title") or re.sub(
        r"\.xml$",
        "",
        _basename(source_name),
        flags=re.IGNORECASE,
    )

    container = next(
        (
            section
            for section in _descendants(assessment, "section")
            if section.get("ident") == "CONTAINER_SECTION"
        ),
        None,
    )
    if container is None:
        raise ConversionError(
            f"{source_name}: no CONTAINER_SECTION was found."
        )

    item_nodes = [
        node
        for node in container.iterdescendants()
        if isinstance(node.tag, str) and _local_name(node) == "item"
    ]

    questions = [
        Question(
            node=item,
            question_type=_question_type(item),
            fingerprint=_fingerprint(item),
            references=_local_references(item),
        )
        for item in item_nodes
    ]

    return Assessment(
        source_name=source_name,
        title=title,
        questions=questions,
    )


def _question_type(item: etree._Element) -> str:
    for field in _descendants(item, "qti_metadatafield"):
        label = _direct_child(field, "fieldlabel")
        entry = _direct_child(field, "fieldentry")
        if label is not None and (label.text or "").strip() == "qmd_questiontype":
            return (entry.text or "").strip() if entry is not None else "Unknown"
    return "Unknown"


def _count_local(item: etree._Element, local_name: str) -> int:
    return sum(
        1
        for node in item.iterdescendants()
        if isinstance(node.tag, str) and _local_name(node) == local_name
    )


def _mattext_values(item: etree._Element) -> list[str]:
    values: list[str] = []
    for node in _descendants(item, "mattext"):
        values.append("".join(node.itertext()))
    return values


def _fingerprint(item: etree._Element) -> dict:
    return {
        "type": _question_type(item),
        "counts": {
            tag: _count_local(item, tag)
            for tag in QUESTION_COUNT_TAGS
        },
        "mattext": _mattext_values(item),
    }


def _fingerprints_match(left: dict, right: dict) -> bool:
    return left == right


def _local_references(item: etree._Element) -> list[str]:
    refs: list[str] = []
    for mattext in _descendants(item, "mattext"):
        text = "".join(mattext.itertext())
        for match in LOCAL_REF_RE.finditer(text):
            value = match.group(1)
            if re.match(
                r"^(?:https?:|data:|mailto:|tel:|#)",
                value,
                flags=re.IGNORECASE,
            ):
                continue
            refs.append(value)
    return refs


def _contains_identity_metadata(item: etree._Element) -> bool:
    for field in _descendants(item, "qti_metadatafield"):
        label = _direct_child(field, "fieldlabel")
        value = (label.text or "").strip() if label is not None else ""
        if value in {"qmd_globalid", "qmd_displayid"}:
            return True
    return False


def _remove_identity_metadata(item: etree._Element) -> None:
    for field in list(_descendants(item, "qti_metadatafield")):
        label = _direct_child(field, "fieldlabel")
        value = (label.text or "").strip() if label is not None else ""
        if value in {"qmd_globalid", "qmd_displayid"}:
            parent = field.getparent()
            if parent is not None:
                parent.remove(field)


def _assessment_candidates_from_zip(
    archive: zipfile.ZipFile,
) -> tuple[list[str], list[str]]:
    names = [name for name in archive.namelist() if not name.endswith("/")]
    warnings: list[str] = []

    manifest_name = _find_name(names, "imsmanifest.xml")
    candidate_names: list[str] = []

    if manifest_name:
        manifest = _parse_xml(
            archive.read(manifest_name),
            manifest_name,
        )
        for href in _manifest_selfassessment_hrefs(manifest):
            found = _find_name(names, href)
            if found:
                candidate_names.append(found)
            else:
                warnings.append(
                    f"Manifest references {href}, but it was not found in the ZIP."
                )

    if not candidate_names:
        candidate_names = [
            name
            for name in names
            if re.search(
                r"(?:^|/)selfassess_d2l_.*\.xml$",
                _normalize_path(name),
                flags=re.IGNORECASE,
            )
        ]
        if not manifest_name:
            warnings.append(
                "No imsmanifest.xml was found. "
                "Self-Assessments were discovered by filename."
            )

    unique = list(dict.fromkeys(candidate_names))
    return unique, warnings


def _assessments_from_zip(
    name: str,
    data: bytes,
) -> tuple[list[Assessment], list[str]]:
    try:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            candidates, warnings = _assessment_candidates_from_zip(archive)
            if not candidates:
                raise ConversionError(
                    f"{name}: no Brightspace Self-Assessment XML files were found."
                )
            assessments = [
                _parse_assessment(archive.read(candidate), candidate)
                for candidate in candidates
            ]
            return assessments, warnings
    except zipfile.BadZipFile as exc:
        raise ConversionError(f"{name}: invalid ZIP package.") from exc


def _assessments_from_loose_xml(
    uploads: list[tuple[str, bytes]],
) -> tuple[list[Assessment], list[str]]:
    warnings: list[str] = []
    by_name = {
        _normalize_path(name): (name, data)
        for name, data in uploads
    }

    manifest = next(
        (
            (name, data)
            for name, data in uploads
            if _basename(name).lower() == "imsmanifest.xml"
        ),
        None,
    )

    candidates: list[tuple[str, bytes]] = []

    if manifest:
        manifest_root = _parse_xml(manifest[1], manifest[0])
        for href in _manifest_selfassessment_hrefs(manifest_root):
            normalized = _normalize_path(href)
            match = by_name.get(normalized)
            if match is None:
                base = _basename(normalized)
                same_base = [
                    value
                    for key, value in by_name.items()
                    if _basename(key) == base
                ]
                match = same_base[0] if len(same_base) == 1 else None
            if match:
                candidates.append(match)
            else:
                warnings.append(
                    f"Manifest references {href}, but that XML file was not supplied."
                )

    if not candidates:
        candidates = [
            (name, data)
            for name, data in uploads
            if re.match(
                r"^selfassess_d2l_.*\.xml$",
                _basename(name),
                flags=re.IGNORECASE,
            )
        ]

    unique: dict[str, tuple[str, bytes]] = {}
    for item in candidates:
        unique[_normalize_path(item[0])] = item

    if not unique:
        raise ConversionError(
            "No Brightspace Self-Assessment XML files were supplied."
        )

    return [
        _parse_assessment(data, name)
        for name, data in unique.values()
    ], warnings


def _create_section_scaffolding(section: etree._Element) -> None:
    presentation = etree.SubElement(section, "presentation_material")
    flow1 = etree.SubElement(presentation, "flow_mat")
    flow2 = etree.SubElement(flow1, "flow_mat")
    material = etree.SubElement(flow2, "material")
    mattext = etree.SubElement(material, "mattext")
    mattext.set("texttype", "text/plain")
    mattext.text = ""

    extension = etree.SubElement(section, "sectionproc_extension")
    display_name = etree.SubElement(
        extension,
        f"{{{D2L_NS}}}display_section_name",
    )
    display_name.text = "no"
    display_line = etree.SubElement(
        extension,
        f"{{{D2L_NS}}}display_section_line",
    )
    display_line.text = "no"
    type_display = etree.SubElement(
        extension,
        f"{{{D2L_NS}}}type_display_section",
    )
    type_display.text = "0"


def _build_questiondb(
    assessments: list[Assessment],
) -> bytes:
    root = etree.Element("questestinterop")
    objectbank = etree.SubElement(
        root,
        "objectbank",
        ident="QLIB_SELFASSESS_MIGRATION",
        nsmap={"d2l_2p0": D2L_NS},
    )

    section_id = 1
    item_id = 1001

    for assessment_index, assessment in enumerate(assessments, start=1):
        section = etree.SubElement(
            objectbank,
            "section",
            ident=f"SECT_SELFASSESS_{assessment_index}",
            title=assessment.title,
        )
        section.set(f"{{{D2L_NS}}}id", str(section_id))
        section_id += 1

        _create_section_scaffolding(section)

        for question in assessment.questions:
            copied = copy.deepcopy(question.node)
            copied.set(f"{{{D2L_NS}}}id", str(item_id))
            item_id += 1
            _remove_identity_metadata(copied)
            section.append(copied)

    return etree.tostring(
        root,
        encoding="UTF-8",
        xml_declaration=True,
        pretty_print=False,
    )


def _build_manifest() -> bytes:
    manifest = etree.Element(
        f"{{{IMSCP_NS}}}manifest",
        nsmap={None: IMSCP_NS, "d2l_2p0": D2L_NS},
        identifier="MANIFEST_SELFASSESS_QUESTION_LIBRARY",
    )
    resources = etree.SubElement(
        manifest,
        f"{{{IMSCP_NS}}}resources",
    )
    resource = etree.SubElement(
        resources,
        f"{{{IMSCP_NS}}}resource",
        identifier="res_question_library",
        type="webcontent",
        href="questiondb.xml",
        title="Question Library",
    )
    resource.set(
        f"{{{D2L_NS}}}material_type",
        "d2lquestionlibrary",
    )
    resource.set(
        f"{{{D2L_NS}}}link_target",
        "",
    )

    return etree.tostring(
        manifest,
        encoding="UTF-8",
        xml_declaration=True,
        pretty_print=False,
    )


def _validate(
    assessments: list[Assessment],
    manifest_bytes: bytes,
    questiondb_bytes: bytes,
) -> None:
    manifest = _parse_xml(manifest_bytes, "generated imsmanifest.xml")
    questiondb = _parse_xml(questiondb_bytes, "generated questiondb.xml")

    q_resource = next(
        (
            resource
            for resource in _descendants(manifest, "resource")
            if (
                resource.get(f"{{{D2L_NS}}}material_type")
                or resource.get("d2l_2p0:material_type")
            ) == "d2lquestionlibrary"
        ),
        None,
    )
    if q_resource is None or q_resource.get("href") != "questiondb.xml":
        raise ConversionError(
            "Generated manifest does not contain a valid Question Library resource."
        )

    if _local_name(questiondb) != "questestinterop":
        raise ConversionError(
            "Generated questiondb.xml does not begin with questestinterop."
        )

    objectbank = _direct_child(questiondb, "objectbank")
    if objectbank is None:
        raise ConversionError(
            "Generated questiondb.xml is missing the required objectbank."
        )

    sections = _direct_children(objectbank, "section")
    if len(sections) != len(assessments):
        raise ConversionError(
            "Question Library folder count does not match the source."
        )

    generated_ids: list[str] = []

    for assessment, section in zip(assessments, sections, strict=True):
        if section.get("title") != assessment.title:
            raise ConversionError(
                f'Folder title changed during conversion: "{assessment.title}".'
            )

        section_id = section.get(f"{{{D2L_NS}}}id")
        if not section_id:
            raise ConversionError(
                f'Folder "{assessment.title}" is missing d2l_2p0:id.'
            )
        generated_ids.append(section_id)

        output_items = _direct_children(section, "item")
        if len(output_items) != len(assessment.questions):
            raise ConversionError(
                f'Question count changed in "{assessment.title}".'
            )

        for index, (source_question, output_item) in enumerate(
            zip(assessment.questions, output_items, strict=True),
            start=1,
        ):
            item_id = output_item.get(f"{{{D2L_NS}}}id")
            if not item_id:
                raise ConversionError(
                    f'"{assessment.title}" question {index} is missing d2l_2p0:id.'
                )
            generated_ids.append(item_id)

            if not _fingerprints_match(
                source_question.fingerprint,
                _fingerprint(output_item),
            ):
                raise ConversionError(
                    f'"{assessment.title}" question {index} changed structurally.'
                )

            if _contains_identity_metadata(output_item):
                raise ConversionError(
                    f'"{assessment.title}" question {index} still contains '
                    "qmd_globalid or qmd_displayid."
                )

            if source_question.references != _local_references(output_item):
                raise ConversionError(
                    f'"{assessment.title}" question {index} had a local '
                    "src/href reference changed."
                )

    if len(generated_ids) != len(set(generated_ids)):
        raise ConversionError(
            "Generated section/question d2l_2p0:id values are not unique."
        )

    questiondb_text = questiondb_bytes.decode("utf-8")
    if (
        'xmlns:ns0="http://www.w3.org/2000/xmlns/"' in questiondb_text
        or "ns0:d2l_2p0=" in questiondb_text
    ):
        raise ConversionError(
            "Invalid namespace serialization was detected."
        )


def _build_zip(
    manifest_bytes: bytes,
    questiondb_bytes: bytes,
) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(
        buffer,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=6,
    ) as archive:
        archive.writestr("imsmanifest.xml", manifest_bytes)
        archive.writestr("questiondb.xml", questiondb_bytes)

    package = buffer.getvalue()

    # Fail closed against the exact bytes that will be returned.
    try:
        with zipfile.ZipFile(io.BytesIO(package), "r") as archive:
            names = archive.namelist()
            if "imsmanifest.xml" not in names or "questiondb.xml" not in names:
                raise ConversionError(
                    "Final ZIP is missing required XML files at its root."
                )
            _parse_xml(
                archive.read("imsmanifest.xml"),
                "final imsmanifest.xml",
            )
            _parse_xml(
                archive.read("questiondb.xml"),
                "final questiondb.xml",
            )
    except zipfile.BadZipFile as exc:
        raise ConversionError("Final ZIP could not be reopened.") from exc

    return package


def _report(assessments: list[Assessment]) -> list[dict]:
    result: list[dict] = []
    for assessment in assessments:
        counts = Counter(
            question.question_type
            for question in assessment.questions
        )
        result.append(
            {
                "title": assessment.title,
                "source": assessment.source_name,
                "questionCount": len(assessment.questions),
                "questionTypes": dict(counts),
            }
        )
    return result


def convert_uploads(
    uploads: list[tuple[str, bytes]],
) -> ConversionResult:
    """
    Convert a Brightspace export ZIP or loose Self-Assessment XML files.

    The output package contains only imsmanifest.xml and questiondb.xml.
    Referenced course media is intentionally not copied: this tool is for
    importing the resulting Question Library package back into the same course.
    """
    if not uploads:
        raise ConversionError("No files were supplied.")

    zip_uploads = [
        (name, data)
        for name, data in uploads
        if name.lower().endswith(".zip")
    ]
    xml_uploads = [
        (name, data)
        for name, data in uploads
        if name.lower().endswith(".xml")
    ]

    if len(zip_uploads) > 1:
        raise ConversionError(
            "Select one Brightspace export ZIP at a time."
        )

    warnings: list[str] = []

    if zip_uploads:
        if xml_uploads:
            warnings.append(
                "A ZIP and loose XML files were supplied together. "
                "The ZIP was used and the loose XML files were ignored."
            )
        assessments, discovered_warnings = _assessments_from_zip(
            zip_uploads[0][0],
            zip_uploads[0][1],
        )
        warnings.extend(discovered_warnings)
    else:
        if not xml_uploads:
            raise ConversionError(
                "Supply a Brightspace export ZIP or at least one "
                "Self-Assessment XML file."
            )
        assessments, discovered_warnings = _assessments_from_loose_xml(
            xml_uploads
        )
        warnings.extend(discovered_warnings)

    if not assessments:
        raise ConversionError("No Self-Assessments were found.")

    manifest_bytes = _build_manifest()
    questiondb_bytes = _build_questiondb(assessments)

    _validate(
        assessments,
        manifest_bytes,
        questiondb_bytes,
    )

    package_bytes = _build_zip(
        manifest_bytes,
        questiondb_bytes,
    )

    return ConversionResult(
        package_bytes=package_bytes,
        report=_report(assessments),
        warnings=warnings,
    )
