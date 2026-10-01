(() => {
  "use strict";

  const D2L_NS = "http://desire2learn.com/xsd/d2lcp_v2p0";
  const QUESTION_LIBRARY_OUTPUT_NAME = "Brightspace_QuestionLibrary_Migration.zip";
  const QUIZ_OUTPUT_NAME = "Brightspace_SelfAssessment_Quizzes.zip";
  const HTML_OUTPUT_ZIP_NAME = "Brightspace_Interactive_HTML_Practices.zip";
  const XML_DEC = '<?xml version="1.0" encoding="UTF-8"?>';
  const BUILD = "1.2.1";

  const fileInput = document.getElementById("file-input");
  const dropZone = document.getElementById("drop-zone");
  const resetButton = document.getElementById("reset-button");
  const analysisPanel = document.getElementById("analysis-panel");
  const sourceSummary = document.getElementById("source-summary");
  const analysisStatus = document.getElementById("analysis-status");
  const assessmentList = document.getElementById("assessment-list");
  const analysisWarnings = document.getElementById("analysis-warnings");
  const convertButton = document.getElementById("convert-button");
  const resultPanel = document.getElementById("result-panel");
  const resultStatus = document.getElementById("result-status");
  const validationList = document.getElementById("validation-list");
  const resultMessages = document.getElementById("result-messages");
  const downloadLink = document.getElementById("download-link");
  const outputModeInputs = [...document.querySelectorAll('input[name="output-mode"]')];

  let state = freshState();

  function freshState() {
    return {
      sourceKind: null,
      sourceName: "",
      assessments: [],
      warnings: [],
      outputUrl: null,
      inputFiles: []
    };
  }

  fileInput.addEventListener("change", () => handleFiles([...fileInput.files]));
  resetButton.addEventListener("click", resetApp);
  convertButton.addEventListener("click", convertAndPackage);
  outputModeInputs.forEach(input => {
    input.addEventListener("change", () => {
      resetOutputOnly();
      updateConversionUi();
    });
  });

  ["dragenter", "dragover"].forEach(type => {
    dropZone.addEventListener(type, event => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach(type => {
    dropZone.addEventListener(type, event => {
      event.preventDefault();
      event.stopPropagation();
      dropZone.classList.remove("drag-over");
    });
  });

  dropZone.addEventListener("drop", event => {
    const files = [...event.dataTransfer.files];
    if (files.length) handleFiles(files);
  });

  async function handleFiles(files) {
    resetOutputOnly();
    state = freshState();
    state.inputFiles = files;
    resetButton.disabled = false;
    analysisPanel.classList.remove("hidden");
    assessmentList.innerHTML = "";
    analysisWarnings.innerHTML = "";
    setStatus(analysisStatus, "Analyzing…", "");
    convertButton.disabled = true;

    try {
      const zipFiles = files.filter(f => /\.zip$/i.test(f.name));
      const xmlFiles = files.filter(f => /\.xml$/i.test(f.name));

      if (zipFiles.length > 1) throw new Error("Select one Brightspace ZIP at a time.");
      if (zipFiles.length && xmlFiles.length) {
        state.warnings.push("A ZIP and loose XML files were selected together. The ZIP will be used and loose XML files will be ignored.");
      }

      if (zipFiles.length) {
        state.sourceKind = "zip";
        state.sourceName = zipFiles[0].name;
        state.assessments = await analyzeZip(zipFiles[0]);
      } else {
        if (!xmlFiles.length) throw new Error("Select a Brightspace export ZIP or at least one Self-Assessment XML file.");
        state.sourceKind = "xml";
        state.sourceName = xmlFiles.length === 1 ? xmlFiles[0].name : `${xmlFiles.length} XML files`;
        state.assessments = await analyzeLooseXml(xmlFiles);
      }

      if (!state.assessments.length) throw new Error("No Brightspace Self-Assessments were found in the selected source.");

      renderAnalysis();
      updateConversionUi();
      setStatus(analysisStatus, "Ready", "success");
      convertButton.disabled = false;
    } catch (error) {
      console.error(error);
      sourceSummary.textContent = "The selected source could not be analyzed.";
      showMessage(analysisWarnings, error.message || String(error), "error");
      setStatus(analysisStatus, "Error", "error");
    }
  }

  async function analyzeLooseXml(files) {
    const byName = new Map(files.map(f => [normalizePath(f.name), f]));
    const manifestFile = files.find(f => /^imsmanifest(?:\([^)]*\))?\.xml$/i.test(f.name) || /^imsmanifest\.xml$/i.test(f.name));
    let candidates = [];

    if (manifestFile) {
      const manifestDoc = parseXml(await manifestFile.text(), manifestFile.name);
      const hrefs = selfAssessmentHrefsFromManifest(manifestDoc);
      for (const href of hrefs) {
        const match = findLooseFile(byName, href);
        if (match) candidates.push(match);
        else state.warnings.push(`Manifest references ${href}, but that XML file was not selected.`);
      }
    }

    if (!candidates.length) {
      candidates = files.filter(f => /^selfassess_d2l_.*\.xml$/i.test(f.name));
    }

    const unique = [...new Map(candidates.map(f => [f.name, f])).values()];
    const results = [];
    for (const file of unique) {
      results.push(parseSelfAssessment(await file.text(), file.name));
    }
    return results;
  }

  async function analyzeZip(file) {
    const archive = new SelectiveZipReader(file);
    await archive.init();

    const manifestEntry = archive.findEntry("imsmanifest.xml");
    let candidateEntries = [];

    if (manifestEntry) {
      const manifestText = await archive.readText(manifestEntry);
      const manifestDoc = parseXml(manifestText, "imsmanifest.xml");
      const hrefs = selfAssessmentHrefsFromManifest(manifestDoc);
      for (const href of hrefs) {
        const entry = archive.findEntry(href);
        if (entry) candidateEntries.push(entry);
        else state.warnings.push(`Manifest references ${href}, but that file was not found in the ZIP.`);
      }
    }

    if (!candidateEntries.length) {
      candidateEntries = archive.entries.filter(entry => /(^|\/)selfassess_d2l_.*\.xml$/i.test(entry.name));
      if (!manifestEntry) state.warnings.push("No imsmanifest.xml was found. Self-Assessments were discovered by filename instead.");
    }

    const unique = [...new Map(candidateEntries.map(e => [e.name, e])).values()];
    const results = [];
    for (const entry of unique) {
      const text = await archive.readText(entry);
      results.push(parseSelfAssessment(text, entry.name));
    }
    return results;
  }

  function selfAssessmentHrefsFromManifest(doc) {
    const resources = [...doc.getElementsByTagNameNS("*", "resource")];
    return resources
      .filter(resource => {
        const materialType = resource.getAttributeNS(D2L_NS, "material_type") || resource.getAttribute("d2l_2p0:material_type");
        return materialType === "d2lselfassess";
      })
      .map(resource => resource.getAttribute("href"))
      .filter(Boolean)
      .map(normalizePath);
  }

  function findLooseFile(byName, href) {
    const normalized = normalizePath(href);
    if (byName.has(normalized)) return byName.get(normalized);
    const basename = normalized.split("/").pop();
    const matches = [...byName.entries()].filter(([name]) => name.split("/").pop() === basename);
    return matches.length === 1 ? matches[0][1] : null;
  }

  function parseSelfAssessment(xmlText, sourceName) {
    const doc = parseXml(xmlText, sourceName);
    const assessment = firstByLocalName(doc, "assessment");
    if (!assessment) throw new Error(`${sourceName}: no <assessment> element was found.`);

    const title = assessment.getAttribute("title") || sourceName.replace(/\.xml$/i, "");
    const sections = [...assessment.getElementsByTagName("section")];
    const container = sections.find(s => s.getAttribute("ident") === "CONTAINER_SECTION");
    if (!container) throw new Error(`${sourceName}: no CONTAINER_SECTION was found.`);

    const items = [...container.getElementsByTagName("item")];
    const questions = items.map((item, index) => ({
      index,
      node: item,
      type: getQuestionType(item),
      fingerprint: fingerprint(item),
      references: extractLocalReferences(item)
    }));

    return { sourceName, title, doc, assessmentNode: assessment, container, questions };
  }

  function renderAnalysis() {
    const totalQuestions = state.assessments.reduce((sum, a) => sum + a.questions.length, 0);
    sourceSummary.textContent = `${state.sourceName}: ${state.assessments.length} Self-Assessment${state.assessments.length === 1 ? "" : "s"}, ${totalQuestions} question${totalQuestions === 1 ? "" : "s"}.`;

    assessmentList.innerHTML = "";
    state.assessments.forEach(assessment => {
      const typeCounts = countTypes(assessment.questions);
      const card = document.createElement("article");
      card.className = "assessment-card";
      const left = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = assessment.title;
      const source = document.createElement("p");
      source.textContent = assessment.sourceName;
      const chips = document.createElement("div");
      chips.className = "type-list";
      for (const [type, count] of Object.entries(typeCounts)) {
        const chip = document.createElement("span");
        chip.className = "type-chip";
        chip.textContent = `${type}: ${count}`;
        chips.appendChild(chip);
      }
      left.append(title, source, chips);
      const count = document.createElement("div");
      count.className = "question-count";
      count.textContent = `${assessment.questions.length} question${assessment.questions.length === 1 ? "" : "s"}`;
      card.append(left, count);
      assessmentList.appendChild(card);
    });

    analysisWarnings.innerHTML = "";
    state.warnings.forEach(w => showMessage(analysisWarnings, w, "warning"));
  }

  function currentOutputMode() {
    return outputModeInputs.find(input => input.checked)?.value || "question-library";
  }

  function updateConversionUi() {
    const mode = currentOutputMode();
    if (mode === "quizzes") {
      convertButton.textContent = "Create Quiz package";
      downloadLink.textContent = "Download Brightspace Quiz ZIP";
      downloadLink.download = QUIZ_OUTPUT_NAME;
    } else if (mode === "interactive-html") {
      convertButton.textContent = "Create interactive HTML";
      downloadLink.textContent = "Download Brightspace HTML";
      downloadLink.removeAttribute("download");
    } else {
      convertButton.textContent = "Create Question Library package";
      downloadLink.textContent = "Download Brightspace Question Library ZIP";
      downloadLink.download = QUESTION_LIBRARY_OUTPUT_NAME;
    }
  }

  async function convertAndPackage() {
    convertButton.disabled = true;
    resultPanel.classList.remove("hidden");
    resultMessages.innerHTML = "";
    validationList.innerHTML = "";
    downloadLink.classList.add("hidden");
    setStatus(resultStatus, "Converting…", "");

    try {
      const mode = currentOutputMode();
      let outputFiles = [];
      let outputName = "";
      let validation;
      let quizCount = 0;
      let htmlCount = 0;
      let outputBlob = null;

      if (mode === "quizzes") {
        const quizPackage = buildQuizzes(state.assessments);
        outputFiles = [
          { name: "imsmanifest.xml", text: quizPackage.manifestXml },
          ...quizPackage.quizFiles.map(file => ({ name: file.name, text: file.xml }))
        ];
        outputName = QUIZ_OUTPUT_NAME;
        quizCount = quizPackage.quizFiles.length;
        validation = validateQuizConversion(state.assessments, quizPackage.manifestXml, quizPackage.quizFiles);
      } else if (mode === "interactive-html") {
        const htmlPackage = buildInteractiveHtmlPages(state.assessments);
        outputFiles = htmlPackage.pages.map(page => ({ name: page.name, text: page.html }));
        htmlCount = htmlPackage.pages.length;
        validation = validateInteractiveHtmlPages(htmlPackage.pages);

        htmlPackage.pages.forEach(page => {
          page.skipped.forEach(skipped => {
            showMessage(
              resultMessages,
              `${page.title}: skipped ${skipped.type || "unsupported"} question (${skipped.reason}).`,
              "warning"
            );
          });
        });

        if (htmlPackage.pages.length === 1) {
          outputName = htmlPackage.pages[0].name;
          outputBlob = new Blob([htmlPackage.pages[0].html], { type: "text/html;charset=utf-8" });
        } else {
          outputName = HTML_OUTPUT_ZIP_NAME;
        }
      } else {
        const questionLibrary = buildQuestionLibrary(state.assessments);
        outputFiles = [
          { name: "imsmanifest.xml", text: questionLibrary.manifestXml },
          { name: "questiondb.xml", text: questionLibrary.questionDbXml }
        ];
        outputName = QUESTION_LIBRARY_OUTPUT_NAME;
        validation = validateConversion(state.assessments, questionLibrary.manifestXml, questionLibrary.questionDbXml, questionLibrary.mappings);
      }

      renderValidation(validation.checks, mode, quizCount, htmlCount);

      if (!validation.ok) {
        setStatus(resultStatus, "Validation failed", "error");
        showMessage(resultMessages, "The output was not generated because one or more validation checks failed.", "error");
        return;
      }

      if (!outputBlob) {
        outputBlob = createStoredZip(outputFiles);

        // Validate the ZIP bytes that will actually be returned.
        const outputFile = new File([outputBlob], outputName, { type: "application/zip" });
        const zipCheck = new SelectiveZipReader(outputFile);
        await zipCheck.init();

        for (const file of outputFiles) {
          const entry = zipCheck.findEntry(file.name);
          if (!entry) throw new Error(`Final ZIP validation failed: ${file.name} was not found at ZIP root.`);
          if (/\.xml$/i.test(file.name)) parseXml(await zipCheck.readText(entry), `final ${file.name}`);
        }
      }

      if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
      state.outputUrl = URL.createObjectURL(outputBlob);
      downloadLink.href = state.outputUrl;
      downloadLink.download = outputName;
      downloadLink.textContent = mode === "interactive-html"
        ? (htmlCount === 1 ? "Download Brightspace HTML page" : "Download Brightspace HTML ZIP")
        : (mode === "quizzes" ? "Download Brightspace Quiz ZIP" : "Download Brightspace Question Library ZIP");
      downloadLink.classList.remove("hidden");
      setStatus(resultStatus, "Output passed local validation", "success");
    } catch (error) {
      console.error(error);
      setStatus(resultStatus, "Error", "error");
      showMessage(resultMessages, error.message || String(error), "error");
    } finally {
      convertButton.disabled = false;
    }
  }

  function buildQuestionLibrary(assessments) {
    const outDoc = parseXml(`${XML_DEC}<questestinterop xmlns:d2l_2p0="${D2L_NS}"><objectbank ident="QLIB_1"></objectbank></questestinterop>`, "generated Question Library scaffold");
    const objectBank = firstByLocalName(outDoc, "objectbank");
    const mappings = [];
    let sectionId = 1;
    let itemId = 1001;

    assessments.forEach((assessment, assessmentIndex) => {
      const section = outDoc.createElement("section");
      section.setAttributeNS(D2L_NS, "d2l_2p0:id", String(sectionId++));
      section.setAttribute("ident", `SECT_SELFASSESS_${assessmentIndex + 1}`);
      section.setAttribute("title", assessment.title);

      section.appendChild(createSectionPresentation(outDoc));
      section.appendChild(createSectionExtension(outDoc));

      assessment.questions.forEach(question => {
        const copied = outDoc.importNode(question.node, true);
        copied.setAttributeNS(D2L_NS, "d2l_2p0:id", String(itemId++));
        removeIdentityMetadata(copied);
        section.appendChild(copied);
        mappings.push({ assessmentIndex, questionIndex: question.index, source: question.node, copied });
      });

      objectBank.appendChild(section);
    });

    const questionDbXml = serializeXml(outDoc);
    const manifestXml = `${XML_DEC}\n<manifest identifier="MANIFEST_SELFASSESS_QUESTION_LIBRARY" xmlns:d2l_2p0="${D2L_NS}" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><resources><resource identifier="res_question_library" type="webcontent" d2l_2p0:material_type="d2lquestionlibrary" d2l_2p0:link_target="" href="questiondb.xml" title="Question Library" /></resources></manifest>`;

    return { manifestXml, questionDbXml, mappings };
  }


  function buildQuizzes(assessments) {
    const quizFiles = [];
    const resources = [];

    assessments.forEach((assessment, assessmentIndex) => {
      const number = assessmentIndex + 1;
      const resourceId = `res_quiz_migrated_${number}`;
      const filename = `quiz_d2l_migrated_${number}.xml`;
      const outDoc = parseXml(`${XML_DEC}<questestinterop xmlns:d2l_2p0="${D2L_NS}"></questestinterop>`, "generated Quiz scaffold");
      const root = outDoc.documentElement;
      const quizAssessment = outDoc.createElement("assessment");

      quizAssessment.setAttributeNS(D2L_NS, "d2l_2p0:id", String(number));
      quizAssessment.setAttribute("title", assessment.title);
      quizAssessment.setAttribute("ident", resourceId);

      quizAssessment.appendChild(createQuizRubric(outDoc));
      quizAssessment.appendChild(createQuizAssessmentControl(outDoc, assessment.assessmentNode));

      const sourcePresentation = directChildren(assessment.assessmentNode).find(node => node.localName === "presentation_material");
      quizAssessment.appendChild(
        sourcePresentation
          ? outDoc.importNode(sourcePresentation, true)
          : createQuizPresentation(outDoc)
      );

      quizAssessment.appendChild(createQuizProcessExtension(outDoc));
      quizAssessment.appendChild(createQuizFeedback(outDoc));

      const copiedContainer = outDoc.importNode(assessment.container, true);
      [...copiedContainer.getElementsByTagName("item")].forEach(item => {
        removeIdentityMetadata(item);
        ensureQuizQuestionWeight(item);
      });
      quizAssessment.appendChild(copiedContainer);
      root.appendChild(quizAssessment);

      const xml = serializeXml(outDoc);
      quizFiles.push({ name: filename, xml, resourceId, title: assessment.title });
      resources.push(
        `<resource identifier="${escapeXmlAttr(resourceId)}" type="webcontent" d2l_2p0:material_type="d2lquiz" d2l_2p0:link_target="" href="${escapeXmlAttr(filename)}" title="${escapeXmlAttr(assessment.title)}" />`
      );
    });

    const manifestXml = `${XML_DEC}
<manifest identifier="MANIFEST_SELFASSESS_QUIZZES" xmlns:d2l_2p0="${D2L_NS}" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><resources>${resources.join("")}</resources></manifest>`;

    return { manifestXml, quizFiles };
  }

  function createQuizRubric(doc) {
    const rubric = doc.createElement("rubric");
    const flow = doc.createElement("flow_mat");
    const material = doc.createElement("material");
    const mattext = doc.createElement("mattext");
    mattext.setAttributeNS(D2L_NS, "d2l_2p0:isdisplayed", "yes");
    mattext.setAttribute("texttype", "text/plain");
    material.appendChild(mattext);
    flow.appendChild(material);
    rubric.appendChild(flow);
    return rubric;
  }

  function createQuizAssessmentControl(doc, sourceAssessment) {
    const control = doc.createElement("assessmentcontrol");
    control.setAttribute("hide_question_pointsswitch", "no");

    const sourceControl = directChildren(sourceAssessment).find(node => node.localName === "assessmentcontrol");
    for (const name of ["hintswitch", "solutionswitch", "feedbackswitch"]) {
      control.setAttribute(name, sourceControl?.getAttribute(name) || "no");
    }
    return control;
  }

  function createQuizPresentation(doc) {
    const presentation = doc.createElement("presentation_material");
    const flow = doc.createElement("flow_mat");

    for (const label of ["page header", "page footer"]) {
      const material = doc.createElement("material");
      material.setAttribute("label", label);
      const mattext = doc.createElement("mattext");
      mattext.setAttributeNS(D2L_NS, "d2l_2p0:isdisplayed", "yes");
      mattext.setAttribute("texttype", "text/html");
      material.appendChild(mattext);
      flow.appendChild(material);
    }

    presentation.appendChild(flow);
    return presentation;
  }

  function appendD2lTextElement(doc, parent, localName, text) {
    const node = doc.createElementNS(D2L_NS, `d2l_2p0:${localName}`);
    if (text !== null && text !== undefined) node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function createQuizProcessExtension(doc) {
    const extension = doc.createElement("assess_procextension");

    const intro = doc.createElementNS(D2L_NS, "d2l_2p0:intro_message");
    intro.setAttributeNS(D2L_NS, "d2l_2p0:isdisplayed", "no");
    intro.setAttribute("texttype", "text/plain");
    extension.appendChild(intro);

    appendD2lTextElement(doc, extension, "disable_right_click", "no");
    appendD2lTextElement(doc, extension, "disable_pager_access", "no");

    const active = doc.createElement("is_active");
    active.textContent = "no";
    extension.appendChild(active);

    appendD2lTextElement(doc, extension, "annotation_tools_enabled", "yes");
    appendD2lTextElement(doc, extension, "date_start", null);
    appendD2lTextElement(doc, extension, "date_end", null);
    appendD2lTextElement(doc, extension, "date_due", null);
    appendD2lTextElement(doc, extension, "has_schedule_event", "no");
    appendD2lTextElement(doc, extension, "is_attempt_Rldb", "no");
    appendD2lTextElement(doc, extension, "is_subview_Rldb", "no");
    appendD2lTextElement(doc, extension, "time_limit", "0");
    appendD2lTextElement(doc, extension, "show_clock", "no");
    appendD2lTextElement(doc, extension, "enforce_time_limit", "no");
    appendD2lTextElement(doc, extension, "quiz_start_type", "no");
    appendD2lTextElement(doc, extension, "grace_period", "0");
    appendD2lTextElement(doc, extension, "late_limit", "0");
    appendD2lTextElement(doc, extension, "attempts_allowed", "1");
    appendD2lTextElement(doc, extension, "attempt_restrictions", null);
    appendD2lTextElement(doc, extension, "mark_calculation_type", "1");
    appendD2lTextElement(doc, extension, "is_forward_only", "no");
    appendD2lTextElement(doc, extension, "paging_type_id", "0");

    return extension;
  }

  function createQuizFeedback(doc) {
    const feedback = doc.createElement("assessfeedback");
    const rubric = doc.createElement("rubric");
    const flow = doc.createElement("flow_mat");
    const material = doc.createElement("material");
    const mattext = doc.createElement("mattext");
    mattext.setAttribute("texttype", "no");

    material.appendChild(mattext);
    flow.appendChild(material);
    rubric.appendChild(flow);
    feedback.appendChild(rubric);

    appendD2lTextElement(doc, feedback, "duration", "0");
    appendD2lTextElement(doc, feedback, "response_display_type_id", "1");
    appendD2lTextElement(doc, feedback, "show_correct_answers", "no");
    appendD2lTextElement(doc, feedback, "submission_restrictip", "no");
    appendD2lTextElement(doc, feedback, "show_class_average", "no");
    appendD2lTextElement(doc, feedback, "show_score_distribution", "no");

    return feedback;
  }

  function ensureQuizQuestionWeight(item) {
    const fields = [...item.getElementsByTagName("qti_metadatafield")];
    let weightField = fields.find(field => {
      const label = [...field.children].find(child => child.localName === "fieldlabel");
      return label?.textContent.trim() === "qmd_weighting";
    });

    if (!weightField) {
      const metadata = firstByLocalName(item, "qtimetadata");
      if (!metadata) return;
      weightField = item.ownerDocument.createElement("qti_metadatafield");
      const label = item.ownerDocument.createElement("fieldlabel");
      const entry = item.ownerDocument.createElement("fieldentry");
      label.textContent = "qmd_weighting";
      entry.textContent = "1.000000000";
      weightField.append(label, entry);
      metadata.appendChild(weightField);
      return;
    }

    const entry = [...weightField.children].find(child => child.localName === "fieldentry");
    if (!entry) return;
    const value = Number.parseFloat(entry.textContent.trim());
    if (!Number.isFinite(value) || value <= 0) entry.textContent = "1.000000000";
  }

  function getQuestionWeight(item) {
    for (const field of [...item.getElementsByTagName("qti_metadatafield")]) {
      const label = [...field.children].find(child => child.localName === "fieldlabel");
      const entry = [...field.children].find(child => child.localName === "fieldentry");
      if (label?.textContent.trim() === "qmd_weighting") {
        const value = Number.parseFloat(entry?.textContent.trim() || "");
        return Number.isFinite(value) ? value : null;
      }
    }
    return null;
  }

  function validateQuizConversion(assessments, manifestXml, quizFiles) {
    const checks = [];
    const pass = message => checks.push({ status: "pass", message });
    const fail = message => checks.push({ status: "fail", message });

    let manifestDoc;
    try {
      manifestDoc = parseXml(manifestXml, "generated imsmanifest.xml");
      pass("Generated imsmanifest.xml is well-formed XML.");
    } catch (error) {
      fail(error.message);
      return { ok: false, checks };
    }

    const resources = [...manifestDoc.getElementsByTagNameNS("*", "resource")]
      .filter(resource => (resource.getAttributeNS(D2L_NS, "material_type") || resource.getAttribute("d2l_2p0:material_type")) === "d2lquiz");

    if (resources.length !== assessments.length || quizFiles.length !== assessments.length) {
      fail(`Expected ${assessments.length} Quiz resources/files but generated ${quizFiles.length}.`);
      return { ok: false, checks };
    }

    let xmlOk = true;
    let structureOk = true;

    assessments.forEach((assessment, index) => {
      const file = quizFiles[index];
      const resource = resources[index];
      let quizDoc;

      try {
        quizDoc = parseXml(file.xml, file.name);
      } catch (error) {
        xmlOk = false;
        structureOk = false;
        return;
      }

      if (
        resource.getAttribute("href") !== file.name ||
        resource.getAttribute("title") !== assessment.title ||
        resource.getAttribute("identifier") !== file.resourceId
      ) structureOk = false;

      const quizAssessment = firstByLocalName(quizDoc, "assessment");
      if (!quizAssessment || quizAssessment.getAttribute("title") !== assessment.title) {
        structureOk = false;
        return;
      }

      const children = directChildren(quizAssessment).map(node => node.localName);
      const required = ["rubric", "assessmentcontrol", "presentation_material", "assess_procextension", "assessfeedback", "section"];
      if (!required.every(name => children.includes(name))) structureOk = false;

      const container = directChildren(quizAssessment).find(node => node.localName === "section" && node.getAttribute("ident") === "CONTAINER_SECTION");
      if (!container) {
        structureOk = false;
        return;
      }

      const outItems = [...container.getElementsByTagName("item")];
      if (outItems.length !== assessment.questions.length) structureOk = false;

      assessment.questions.forEach((sourceQuestion, questionIndex) => {
        const outputItem = outItems[questionIndex];
        if (!outputItem) {
          structureOk = false;
          return;
        }

        if (!fingerprintsMatch(sourceQuestion.fingerprint, fingerprint(outputItem))) structureOk = false;
        if (containsIdentityMetadata(outputItem)) structureOk = false;
        if (!arraysEqual(sourceQuestion.references, extractLocalReferences(outputItem))) structureOk = false;

        const sourceWeight = getQuestionWeight(sourceQuestion.node);
        const outputWeight = getQuestionWeight(outputItem);
        if (sourceWeight !== null && sourceWeight > 0) {
          if (outputWeight !== sourceWeight) structureOk = false;
        } else if (outputWeight !== 1) {
          structureOk = false;
        }
      });

      const process = directChildren(quizAssessment).find(node => node.localName === "assess_procextension");
      const active = process ? directChildren(process).find(node => node.localName === "is_active") : null;
      if (!active || active.textContent.trim() !== "no") structureOk = false;
    });

    if (xmlOk) pass("Generated quiz XML files are well-formed.");
    else fail("One or more generated quiz XML files are invalid.");

    if (structureOk) pass("Quiz structure and source question content passed local validation.");
    else fail("One or more generated quizzes differ unexpectedly from the source.");

    return { ok: checks.every(check => check.status !== "fail"), checks };
  }

  function escapeXmlAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }


  function buildInteractiveHtmlPages(assessments) {
    const usedNames = new Set();

    const pages = assessments.map((assessment, assessmentIndex) => {
      const models = [];
      const skipped = [];

      assessment.questions.forEach(question => {
        if (!isInteractiveSupportedType(question.type)) {
          skipped.push({
            type: question.type,
            reason: "Interactive HTML currently supports Multiple Choice and True/False"
          });
          return;
        }

        const model = buildInteractiveQuestionModel(question.node, question.type);
        if (!model) {
          skipped.push({
            type: question.type,
            reason: "a correct response could not be determined from the Self-Assessment answer processing"
          });
          return;
        }
        models.push(model);
      });

      let base = safeFilename(assessment.title) || `Self_Assessment_${assessmentIndex + 1}`;
      let name = `${base}_Practice.html`;
      let duplicate = 2;
      while (usedNames.has(name.toLowerCase())) {
        name = `${base}_Practice_${duplicate++}.html`;
      }
      usedNames.add(name.toLowerCase());

      return {
        name,
        title: assessment.title,
        html: renderInteractiveHtmlPage(assessment.title, models, skipped),
        supportedCount: models.length,
        skipped
      };
    });

    return { pages };
  }

  function isInteractiveSupportedType(type) {
    return type === "Multiple Choice" || type === "True/False";
  }

  function buildInteractiveQuestionModel(item, type) {
    const presentation = firstByLocalName(item, "presentation");
    const response = presentation
      ? [...presentation.getElementsByTagName("*")].find(node => node.localName === "response_lid")
      : null;
    if (!presentation || !response) return null;

    const questionMattext = [...presentation.getElementsByTagName("*")]
      .find(node => node.localName === "mattext" && !hasAncestorLocalName(node, "response_label", presentation));
    const questionHtml = questionMattext?.textContent || item.getAttribute("title") || "Question";

    const answerLabels = [...response.getElementsByTagName("*")]
      .filter(node => node.localName === "response_label");

    if (answerLabels.length < 2) return null;

    const conditions = [...item.getElementsByTagName("*")]
      .filter(node => node.localName === "respcondition");
    const feedbackNodes = [...item.getElementsByTagName("*")]
      .filter(node => node.localName === "itemfeedback");
    const feedbackById = new Map(
      feedbackNodes
        .map(node => [node.getAttribute("ident"), node])
        .filter(([ident]) => ident)
    );

    const referencedFeedback = new Set();
    const answers = answerLabels.map((label, index) => {
      const ident = label.getAttribute("ident") || `answer_${index}`;
      const textNode = [...label.getElementsByTagName("*")]
        .find(node => node.localName === "mattext");
      const matchingCondition = conditions.find(condition =>
        [...condition.getElementsByTagName("*")].some(node =>
          node.localName === "varequal" && node.textContent.trim() === ident
        )
      );

      let correct = false;
      let feedbackHtml = "";

      if (matchingCondition) {
        const scoreNodes = [...matchingCondition.getElementsByTagName("*")]
          .filter(node => node.localName === "setvar");
        correct = scoreNodes.some(node => {
          const value = node.textContent.trim();
          const numeric = Number.parseFloat(value);
          return (Number.isFinite(numeric) && numeric > 0) || value === "D2L_Correct";
        });

        const feedbackLink = [...matchingCondition.getElementsByTagName("*")]
          .find(node => node.localName === "displayfeedback");
        const feedbackId = feedbackLink?.getAttribute("linkrefid");
        if (feedbackId) {
          referencedFeedback.add(feedbackId);
          const feedbackNode = feedbackById.get(feedbackId);
          const mattext = feedbackNode
            ? [...feedbackNode.getElementsByTagName("*")].find(node => node.localName === "mattext")
            : null;
          feedbackHtml = mattext?.textContent || "";
        }
      }

      return {
        id: index,
        ident,
        html: textNode?.textContent || ident,
        feedbackHtml,
        correct
      };
    });

    if (!answers.some(answer => answer.correct)) return null;

    const itemLabel = item.getAttribute("label");
    let overallFeedbackHtml = "";
    if (itemLabel && feedbackById.has(itemLabel)) {
      const overallNode = feedbackById.get(itemLabel);
      const mattext = [...overallNode.getElementsByTagName("*")]
        .find(node => node.localName === "mattext");
      overallFeedbackHtml = mattext?.textContent || "";
    } else {
      const unreferenced = feedbackNodes.find(node => {
        const ident = node.getAttribute("ident");
        return ident && !referencedFeedback.has(ident);
      });
      const mattext = unreferenced
        ? [...unreferenced.getElementsByTagName("*")].find(node => node.localName === "mattext")
        : null;
      overallFeedbackHtml = mattext?.textContent || "";
    }

    const hint = [...item.getElementsByTagName("*")].find(node => node.localName === "hint");
    const hintMattext = hint
      ? [...hint.getElementsByTagName("*")].find(node => node.localName === "mattext")
      : null;

    return {
      type,
      questionHtml,
      answers,
      hintHtml: hintMattext?.textContent || "",
      overallFeedbackHtml
    };
  }

  function hasAncestorLocalName(node, localName, stopNode) {
    let current = node.parentElement;
    while (current && current !== stopNode) {
      if (current.localName === localName) return true;
      current = current.parentElement;
    }
    return false;
  }

  function renderInteractiveHtmlPage(title, questions, skipped) {
    const questionMarkup = questions.map((question, questionIndex) => {
      const number = questionIndex + 1;
      const groupName = `sa-q-${number}`;
      const answers = question.answers.map((answer, answerIndex) => {
        const id = `${groupName}-a-${answerIndex + 1}`;
        const verdict = answer.correct ? "Correct." : "Incorrect.";
        const feedback = answer.feedbackHtml
          ? `<div class="sa-source-feedback">${answer.feedbackHtml}</div>`
          : "";
        const overall = question.overallFeedbackHtml
          ? `<div class="sa-overall-feedback">${question.overallFeedbackHtml}</div>`
          : "";

        return `
          <div class="sa-answer ${answer.correct ? "correct" : "incorrect"}">
            <input type="radio" id="${id}" name="${groupName}">
            <label for="${id}">${answer.html}</label>
            <div class="sa-feedback" role="status" aria-live="polite">
              <strong>${verdict}</strong>
              ${feedback}
              ${overall}
            </div>
          </div>`;
      }).join("");

      const hint = question.hintHtml
        ? `<details class="sa-hint"><summary>Show hint</summary><div>${question.hintHtml}</div></details>`
        : "";

      const previous = number > 1
        ? `<a class="sa-nav-button secondary" href="#sa-question-${number - 1}">Previous question</a>`
        : '<span class="sa-nav-spacer" aria-hidden="true"></span>';

      const next = number < questions.length
        ? `<a class="sa-nav-button primary" href="#sa-question-${number + 1}">Next question</a>`
        : '<a class="sa-nav-button primary" href="#sa-question-1">Return to first question</a>';

      return `
        <section class="sa-question" id="sa-question-${number}" data-sa-question="${number}" aria-labelledby="sa-question-heading-${number}">
          <div class="sa-progress" aria-label="Question ${number} of ${questions.length}">
            <span>Question ${number} of ${questions.length}</span>
            <div class="sa-progress-track" aria-hidden="true"><span style="width:${Math.round((number / questions.length) * 100)}%"></span></div>
          </div>
          <p class="sa-question-number">${escapeHtml(question.type)}</p>
          <div class="sa-question-text" id="sa-question-heading-${number}">${question.questionHtml}</div>
          <div class="sa-answers">
            ${answers}
          </div>
          ${hint}
          <nav class="sa-navigation" aria-label="Question navigation">
            ${previous}
            ${next}
          </nav>
        </section>`;
    }).join("");

    const skippedMarkup = skipped.length
      ? `<aside class="sa-skipped" role="note">
          <strong>Some source questions were not converted.</strong>
          <p>${skipped.length} question${skipped.length === 1 ? "" : "s"} skipped: ${escapeHtml(
            [...new Set(skipped.map(item => item.type || "Unknown"))].join(", ")
          )}.</p>
        </aside>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://templates.lcs.brightspace.com/lib/assets/css/styles.min.css">
  <link rel="stylesheet" href="/shared/sp-template/styles/SP-bootstrap-grid.css" data-override="override">
  <style>
    :root{--sa-text:#202122;--sa-muted:#5f6670;--sa-border:#d8dde3;--sa-soft:#f7f8fa;--sa-correct:#16734b;--sa-correct-bg:#eaf7f0;--sa-incorrect:#9c2f25;--sa-incorrect-bg:#fff0ef;--sa-hint-bg:#f2f6fb;--sa-accent:#1f5f99;--sa-accent-hover:#194f80}
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{margin:0;color:var(--sa-text);font-family:Verdana,Arial,sans-serif;font-size:14px;line-height:1.55;background:#fff}
    .sa-practice{max-width:900px;margin:0 auto;padding:24px 18px 40px}
    .sa-header{border-bottom:1px solid var(--sa-border);padding-bottom:16px;margin-bottom:22px}
    .sa-header h1{margin:0 0 8px;font-size:1.7rem;line-height:1.25}
    .sa-header p{margin:0;color:var(--sa-muted)}
    .sa-questions .sa-question{display:none}
    .sa-questions .sa-question:first-child{display:block}
    .sa-questions .sa-question:target{display:block}
    .sa-questions:has(.sa-question:target) .sa-question:first-child:not(:target){display:none}
    .sa-question{border:1px solid var(--sa-border);border-radius:10px;background:#fff;padding:20px;margin:0 0 20px;scroll-margin-top:16px}
    .sa-progress{display:grid;gap:7px;margin-bottom:14px;color:var(--sa-muted);font-size:.86rem;font-weight:700}
    .sa-progress-track{height:6px;border-radius:999px;background:#e7ebef;overflow:hidden}
    .sa-progress-track span{display:block;height:100%;background:var(--sa-accent);border-radius:999px}
    .sa-question-number{margin:0 0 8px;color:var(--sa-muted);font-size:.82rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
    .sa-question-text{font-size:1.05rem;font-weight:600;margin-bottom:16px}
    .sa-question-text p:first-child,.sa-answer label p:first-child,.sa-source-feedback p:first-child,.sa-overall-feedback p:first-child{margin-top:0}
    .sa-question-text p:last-child,.sa-answer label p:last-child,.sa-source-feedback p:last-child,.sa-overall-feedback p:last-child{margin-bottom:0}
    .sa-answer{position:relative;margin:10px 0}
    .sa-answer input[type=radio]{position:absolute;top:16px;left:14px;margin:0}
    .sa-answer label{display:block;cursor:pointer;border:1px solid var(--sa-border);border-radius:8px;background:var(--sa-soft);padding:12px 14px 12px 42px;min-height:48px}
    .sa-answer label:hover{border-color:#a9b2bc;background:#fbfcfd}
    .sa-answer input[type=radio]:focus + label{outline:3px solid rgba(31,95,153,.22);outline-offset:2px}
    .sa-answer.correct input[type=radio]:checked + label{border-color:var(--sa-correct);background:var(--sa-correct-bg)}
    .sa-answer.incorrect input[type=radio]:checked + label{border-color:var(--sa-incorrect);background:var(--sa-incorrect-bg)}
    .sa-feedback{display:none;margin:8px 0 0;border-radius:8px;padding:10px 12px}
    .sa-answer.correct input[type=radio]:checked ~ .sa-feedback{display:block;background:var(--sa-correct-bg);color:#0f5e3c;border-left:4px solid var(--sa-correct)}
    .sa-answer.incorrect input[type=radio]:checked ~ .sa-feedback{display:block;background:var(--sa-incorrect-bg);color:#7d241d;border-left:4px solid var(--sa-incorrect)}
    .sa-source-feedback{margin-top:5px}
    .sa-overall-feedback{margin-top:7px;padding-top:7px;border-top:1px solid currentColor;opacity:.9}
    .sa-hint{margin-top:14px;border-radius:8px;background:var(--sa-hint-bg);padding:10px 12px}
    .sa-hint summary{cursor:pointer;font-weight:700;color:var(--sa-accent)}
    .sa-hint div{margin-top:8px}
    .sa-navigation{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:22px;padding-top:18px;border-top:1px solid var(--sa-border)}
    .sa-nav-button{display:inline-flex;align-items:center;justify-content:center;border-radius:8px;padding:10px 14px;text-decoration:none;font-weight:700;min-height:42px}
    .sa-nav-button.primary{background:var(--sa-accent);color:#fff}
    .sa-nav-button.primary:hover,.sa-nav-button.primary:focus{background:var(--sa-accent-hover);color:#fff}
    .sa-nav-button.secondary{background:#eef1f4;color:var(--sa-text)}
    .sa-nav-button.secondary:hover,.sa-nav-button.secondary:focus{background:#e2e6ea;color:var(--sa-text)}
    .sa-nav-spacer{display:block}
    .sa-skipped{margin:18px 0;padding:12px 14px;border-radius:8px;background:#fff5df;color:#7d5200}
    .sa-skipped p{margin:4px 0 0}
    .sa-actions{display:flex;justify-content:flex-end;margin-top:22px}
    .sa-reset{border:1px solid #9ca6b0;border-radius:8px;background:#fff;color:var(--sa-text);padding:9px 14px;font:inherit;font-weight:700;cursor:pointer}
    .sa-reset:hover{background:#f4f6f8}
    @media(max-width:600px){.sa-practice{padding:16px 10px 28px}.sa-question{padding:16px}.sa-navigation{align-items:stretch}.sa-nav-button{flex:1;text-align:center}}
  </style>
</head>
<body>
  <main class="sa-practice">
    <header class="sa-header">
      <h1>${escapeHtml(title)}</h1>
      <p>This is an ungraded practice activity. Select a response to see immediate feedback, then use Next question to continue.</p>
    </header>
    <form>
      <div class="sa-questions">
        ${questionMarkup || '<p>No supported Multiple Choice or True/False questions were found.</p>'}
      </div>
      ${skippedMarkup}
      ${questions.length ? '<div class="sa-actions"><button class="sa-reset" type="reset">Reset responses</button></div>' : ""}
    </form>
  </main>
</body>
</html>`;
  }

  function validateInteractiveHtmlPages(pages) {
    const checks = [];
    const pass = message => checks.push({ status: "pass", message });
    const fail = message => checks.push({ status: "fail", message });

    if (!pages.length) {
      fail("No interactive HTML pages were generated.");
      return { ok: false, checks };
    }

    let structureOk = true;
    pages.forEach(page => {
      if (!/^<!DOCTYPE html>/i.test(page.html.trim())) structureOk = false;
      if (!page.html.includes("<form>")) structureOk = false;
      const generatedQuestions = (page.html.match(/data-sa-question="/g) || []).length;
      if (generatedQuestions !== page.supportedCount) structureOk = false;
      if (page.supportedCount === 0) structureOk = false;
    });

    if (structureOk) pass("Generated interactive HTML page files.");
    else fail("One or more HTML pages did not contain the expected interactive questions.");

    return { ok: checks.every(check => check.status !== "fail"), checks };
  }

  function safeFilename(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[_\.]+|[_\.]+$/g, "")
      .slice(0, 120);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function createSectionPresentation(doc) {
    const presentation = doc.createElement("presentation_material");
    const flow1 = doc.createElement("flow_mat");
    const flow2 = doc.createElement("flow_mat");
    const material = doc.createElement("material");
    const mattext = doc.createElement("mattext");
    mattext.setAttribute("texttype", "text/plain");
    material.appendChild(mattext);
    flow2.appendChild(material);
    flow1.appendChild(flow2);
    presentation.appendChild(flow1);
    return presentation;
  }

  function createSectionExtension(doc) {
    const extension = doc.createElement("sectionproc_extension");
    const displayName = doc.createElementNS(D2L_NS, "d2l_2p0:display_section_name");
    displayName.textContent = "no";
    const displayLine = doc.createElementNS(D2L_NS, "d2l_2p0:display_section_line");
    displayLine.textContent = "no";
    const typeDisplay = doc.createElementNS(D2L_NS, "d2l_2p0:type_display_section");
    typeDisplay.textContent = "0";
    extension.append(displayName, displayLine, typeDisplay);
    return extension;
  }

  function removeIdentityMetadata(item) {
    const fields = [...item.getElementsByTagName("qti_metadatafield")];
    fields.forEach(field => {
      const label = [...field.children].find(child => child.localName === "fieldlabel");
      const value = label ? label.textContent.trim() : "";
      if (value === "qmd_globalid" || value === "qmd_displayid") field.remove();
    });
  }

  function validateConversion(assessments, manifestXml, questionDbXml) {
    const checks = [];
    const pass = message => checks.push({ status: "pass", message });
    const fail = message => checks.push({ status: "fail", message });

    let manifestDoc;
    let questionDoc;
    try { manifestDoc = parseXml(manifestXml, "generated imsmanifest.xml"); pass("Generated imsmanifest.xml is well-formed XML."); }
    catch (e) { fail(e.message); }
    try { questionDoc = parseXml(questionDbXml, "generated questiondb.xml"); pass("Generated questiondb.xml is well-formed XML."); }
    catch (e) { fail(e.message); }

    if (!manifestDoc || !questionDoc) return { ok: false, checks };

    const resources = [...manifestDoc.getElementsByTagNameNS("*", "resource")];
    const qResource = resources.find(r => (r.getAttributeNS(D2L_NS, "material_type") || r.getAttribute("d2l_2p0:material_type")) === "d2lquestionlibrary");
    if (qResource && qResource.getAttribute("href") === "questiondb.xml") pass("Manifest contains a Question Library resource pointing to questiondb.xml.");
    else fail("Manifest Question Library resource is missing or does not point to questiondb.xml.");

    const root = questionDoc.documentElement;
    const objectBank = directChildren(root).find(e => e.localName === "objectbank");
    if (root.localName === "questestinterop" && objectBank) pass("Question Library hierarchy begins questestinterop > objectbank.");
    else fail("Required questestinterop > objectbank hierarchy is missing.");

    if (!objectBank) return { ok: false, checks };
    const sections = directChildren(objectBank).filter(e => e.localName === "section");
    if (sections.length === assessments.length) pass(`Created ${sections.length} Question Library folder${sections.length === 1 ? "" : "s"}, matching the source.`);
    else fail(`Expected ${assessments.length} Question Library folders but generated ${sections.length}.`);

    let structureOk = true;
    assessments.forEach((assessment, aIndex) => {
      const section = sections[aIndex];
      if (!section) { structureOk = false; return; }
      if (section.getAttribute("title") !== assessment.title) structureOk = false;
      const outItems = directChildren(section).filter(e => e.localName === "item");
      if (outItems.length !== assessment.questions.length) structureOk = false;

      assessment.questions.forEach((sourceQuestion, qIndex) => {
        const outItem = outItems[qIndex];
        if (!outItem) { structureOk = false; return; }
        const sourceFp = sourceQuestion.fingerprint;
        const outputFp = fingerprint(outItem);
        if (!fingerprintsMatch(sourceFp, outputFp)) structureOk = false;
        if (containsIdentityMetadata(outItem)) structureOk = false;
        if (!arraysEqual(sourceQuestion.references, extractLocalReferences(outItem))) structureOk = false;
      });
    });

    if (structureOk) pass("Every folder title, question count, question type, response structure, answer processing, feedback structure, and local src/href reference matches the source.");
    else fail("One or more migrated questions differ structurally from the source.");

    const allSectionsAndItems = [
      ...sections,
      ...sections.flatMap(section => directChildren(section).filter(e => e.localName === "item"))
    ];
    const ids = allSectionsAndItems.map(node => node.getAttributeNS(D2L_NS, "id") || node.getAttribute("d2l_2p0:id"));
    if (ids.every(Boolean) && new Set(ids).size === ids.length) pass("Every generated section and question has a unique d2l_2p0:id.");
    else fail("Generated section/question d2l_2p0:id values are missing or duplicated.");

    if (!questionDbXml.includes('xmlns:ns0="http://www.w3.org/2000/xmlns/"') && !questionDbXml.includes("ns0:d2l_2p0=")) pass("No known invalid XML namespace serialization was found.");
    else fail("Invalid XML namespace serialization was detected.");

    const total = assessments.reduce((sum, a) => sum + a.questions.length, 0);
    const outTotal = sections.reduce((sum, section) => sum + directChildren(section).filter(e => e.localName === "item").length, 0);
    if (total === outTotal) pass(`All ${total} source questions are present in the output.`);
    else fail(`Source has ${total} questions but output has ${outTotal}.`);

    return { ok: checks.every(c => c.status !== "fail"), checks };
  }

  function fingerprint(item) {
    const tagCounts = [
      "presentation", "resprocessing", "hint", "itemfeedback",
      "response_lid", "response_str", "response_num", "response_label",
      "respcondition", "varequal", "setvar"
    ].reduce((acc, name) => {
      acc[name] = countByLocalName(item, name);
      return acc;
    }, {});

    return {
      type: getQuestionType(item),
      counts: tagCounts,
      mattext: [...item.getElementsByTagName("mattext")].map(n => n.textContent)
    };
  }

  function fingerprintsMatch(a, b) {
    if (a.type !== b.type) return false;
    for (const key of Object.keys(a.counts)) if (a.counts[key] !== b.counts[key]) return false;
    return arraysEqual(a.mattext, b.mattext);
  }

  function containsIdentityMetadata(item) {
    return [...item.getElementsByTagName("qti_metadatafield")].some(field => {
      const label = [...field.children].find(child => child.localName === "fieldlabel");
      const value = label ? label.textContent.trim() : "";
      return value === "qmd_globalid" || value === "qmd_displayid";
    });
  }

  function getQuestionType(item) {
    for (const field of [...item.getElementsByTagName("qti_metadatafield")]) {
      const label = [...field.children].find(child => child.localName === "fieldlabel");
      const entry = [...field.children].find(child => child.localName === "fieldentry");
      if (label?.textContent.trim() === "qmd_questiontype") return entry?.textContent.trim() || "Unknown";
    }
    return "Unknown";
  }

  function extractLocalReferences(item) {
    const refs = [];
    for (const mattext of [...item.getElementsByTagName("mattext")]) {
      const text = mattext.textContent || "";
      const regex = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
      let match;
      while ((match = regex.exec(text))) {
        const value = match[1];
        if (!/^(?:https?:|data:|mailto:|tel:|#)/i.test(value)) refs.push(value);
      }
    }
    return refs;
  }

  function countTypes(questions) {
    return questions.reduce((acc, q) => {
      acc[q.type] = (acc[q.type] || 0) + 1;
      return acc;
    }, {});
  }

  function countByLocalName(root, localName) {
    return [...root.getElementsByTagName("*")].filter(n => n.localName === localName).length;
  }

  function directChildren(node) {
    return [...node.children];
  }

  function firstByLocalName(root, name) {
    return [...root.getElementsByTagName("*")].find(n => n.localName === name) || null;
  }

  function parseXml(text, name = "XML") {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const parserError = doc.getElementsByTagName("parsererror")[0];
    if (parserError) throw new Error(`${name}: invalid XML (${parserError.textContent.replace(/\s+/g, " ").trim()}).`);
    return doc;
  }

  function serializeXml(doc) {
    const serialized = new XMLSerializer().serializeToString(doc);
    return serialized.startsWith("<?xml") ? serialized : `${XML_DEC}\n${serialized}`;
  }

  function normalizePath(value) {
    return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  }

  function arraysEqual(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function renderValidation(checks, mode = "question-library", quizCount = 0, htmlCount = 0) {
    validationList.innerHTML = "";

    if (mode === "interactive-html") {
      const htmlPassed = checks.some(check =>
        check.status === "pass" &&
        check.message === "Generated interactive HTML page files."
      );
      if (htmlPassed) {
        addValidationRow(
          `Generated ${htmlCount} interactive HTML page${htmlCount === 1 ? "" : "s"}`,
          "pass"
        );
      }
      return;
    }

    const manifestPassed = checks.some(check =>
      check.status === "pass" &&
      check.message === "Generated imsmanifest.xml is well-formed XML."
    );

    if (manifestPassed) addValidationRow("Generated imsmanifest.xml", "pass");

    if (mode === "quizzes") {
      const quizzesPassed = checks.some(check =>
        check.status === "pass" &&
        check.message === "Generated quiz XML files are well-formed."
      );
      if (quizzesPassed) {
        addValidationRow(
          `Generated ${quizCount} quiz file${quizCount === 1 ? "" : "s"}`,
          "pass"
        );
      }
    } else {
      const questionDbPassed = checks.some(check =>
        check.status === "pass" &&
        check.message === "Generated questiondb.xml is well-formed XML."
      );
      if (questionDbPassed) addValidationRow("Generated questiondb.xml", "pass");
    }
  }

  function addValidationRow(message, status) {
    const row = document.createElement("div");
    row.className = `validation-row ${status}`;
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = status === "pass" ? "✓" : status === "warn" ? "!" : "×";
    const text = document.createElement("span");
    text.textContent = message;
    row.append(icon, text);
    validationList.appendChild(row);
  }

  function showMessage(container, text, kind = "info") {
    const div = document.createElement("div");
    div.className = `message ${kind}`;
    div.textContent = text;
    container.appendChild(div);
  }

  function setStatus(element, text, kind) {
    element.textContent = text;
    element.className = "status-pill" + (kind ? ` ${kind}` : "");
  }

  function resetOutputOnly() {
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
    resultPanel.classList.add("hidden");
    downloadLink.classList.add("hidden");
    downloadLink.removeAttribute("href");
  }

  function resetApp() {
    resetOutputOnly();
    state = freshState();
    fileInput.value = "";
    analysisPanel.classList.add("hidden");
    assessmentList.innerHTML = "";
    analysisWarnings.innerHTML = "";
    resetButton.disabled = true;
    convertButton.disabled = true;
    const questionLibraryOption = outputModeInputs.find(input => input.value === "question-library");
    if (questionLibraryOption) questionLibraryOption.checked = true;
    updateConversionUi();
  }

  // Selective ZIP reader: reads only the central directory and entries requested.
  // Supports the standard ZIP format (sufficient for Brightspace's <= 2 GB packages),
  // stored entries (method 0), and Deflate entries (method 8).
  class SelectiveZipReader {
    constructor(file) {
      this.file = file;
      this.entries = [];
    }

    async init() {
      const tailLength = Math.min(this.file.size, 65557);
      const tailStart = this.file.size - tailLength;
      const tail = new Uint8Array(await this.file.slice(tailStart).arrayBuffer());
      const eocdPos = findSignatureBackwards(tail, 0x06054b50);
      if (eocdPos < 0) throw new Error(`${this.file.name}: ZIP end-of-central-directory record was not found.`);

      const view = new DataView(tail.buffer, tail.byteOffset + eocdPos);
      const totalEntries = view.getUint16(10, true);
      const centralSize = view.getUint32(12, true);
      const centralOffset = view.getUint32(16, true);
      if (centralOffset === 0xffffffff || centralSize === 0xffffffff || totalEntries === 0xffff) {
        throw new Error("ZIP64 packages are not supported. Brightspace packages under 2 GB should normally use the standard ZIP format.");
      }

      const central = new Uint8Array(await this.file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
      let offset = 0;
      for (let i = 0; i < totalEntries; i++) {
        if (readU32(central, offset) !== 0x02014b50) throw new Error(`${this.file.name}: invalid ZIP central directory.`);
        const flags = readU16(central, offset + 8);
        const method = readU16(central, offset + 10);
        const crc = readU32(central, offset + 16);
        const compressedSize = readU32(central, offset + 20);
        const uncompressedSize = readU32(central, offset + 24);
        const nameLength = readU16(central, offset + 28);
        const extraLength = readU16(central, offset + 30);
        const commentLength = readU16(central, offset + 32);
        const localOffset = readU32(central, offset + 42);
        const nameBytes = central.slice(offset + 46, offset + 46 + nameLength);
        const name = normalizePath(new TextDecoder("utf-8").decode(nameBytes));
        this.entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
        offset += 46 + nameLength + extraLength + commentLength;
      }
    }

    findEntry(path) {
      const normalized = normalizePath(path);
      const exact = this.entries.find(e => e.name === normalized);
      if (exact) return exact;
      const basename = normalized.split("/").pop();
      const matches = this.entries.filter(e => e.name.split("/").pop() === basename);
      return matches.length === 1 ? matches[0] : null;
    }

    async readText(entry) {
      const bytes = await this.readBytes(entry);
      return new TextDecoder("utf-8").decode(bytes);
    }

    async readBytes(entry) {
      if (entry.flags & 0x0001) throw new Error(`${entry.name}: encrypted ZIP entries are not supported.`);
      const localHeader = new Uint8Array(await this.file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
      if (readU32(localHeader, 0) !== 0x04034b50) throw new Error(`${entry.name}: invalid ZIP local header.`);
      const nameLength = readU16(localHeader, 26);
      const extraLength = readU16(localHeader, 28);
      const dataStart = entry.localOffset + 30 + nameLength + extraLength;
      const compressedBlob = this.file.slice(dataStart, dataStart + entry.compressedSize);

      if (entry.method === 0) return new Uint8Array(await compressedBlob.arrayBuffer());
      if (entry.method === 8) {
        if (typeof DecompressionStream === "undefined") throw new Error("This browser does not provide DecompressionStream, which is required to read compressed Brightspace ZIP files.");
        let stream;
        try {
          stream = compressedBlob.stream().pipeThrough(new DecompressionStream("deflate-raw"));
        } catch {
          throw new Error("This browser cannot decompress standard ZIP Deflate entries. Use a current Chromium-based browser.");
        }
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      throw new Error(`${entry.name}: unsupported ZIP compression method ${entry.method}.`);
    }
  }

  function findSignatureBackwards(bytes, signature) {
    for (let i = bytes.length - 4; i >= 0; i--) if (readU32(bytes, i) === signature) return i;
    return -1;
  }

  function readU16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function readU32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  // Creates a standards-compliant ZIP using the STORE method (no compression).
  // The output contains only the two small XML files, so compression is unnecessary.
  function createStoredZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const { dosDate, dosTime } = toDosDateTime(now);
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    let centralSize = 0;

    files.forEach(file => {
      const nameBytes = encoder.encode(file.name);
      const data = encoder.encode(file.text);
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, localOffset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);
      centralSize += central.length;
      localOffset += local.length + data.length;
    });

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, localOffset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...localParts, ...centralParts, eocd], { type: "application/zip" });
  }

  function toDosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    return { dosDate, dosTime };
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Exposed for a lightweight browser test harness and future modularization.
  window.SAQL = {
    build: BUILD,
    parseXml,
    parseSelfAssessment,
    buildQuestionLibrary,
    buildQuizzes,
    buildInteractiveHtmlPages,
    validateConversion,
    validateQuizConversion,
    createStoredZip,
    SelectiveZipReader
  };
})();
